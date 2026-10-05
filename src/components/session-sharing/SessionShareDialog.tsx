import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../shared/view/ui';
import { Dialog, DialogContent } from '../../shared/view/ui/Dialog';
import { useOptionalAuth } from '../auth/context/AuthContext';

import ShareList from './ShareList';
import SharePreviewTranscript, { RedactionSummary } from './SharePreview';
import {
  SHARE_EXPIRIES, ShareApiError, createShare, listSessionShares, previewShare, shareErrorKey,
  type ShareExpiry, type SharePreview, type ShareSummary,
} from './sessionShareApi';

const NEEDS_CONFIRMATION = 'UNATTRIBUTED_NEEDS_CONFIRMATION';
const checkboxRow = 'flex min-h-11 items-start gap-3 text-sm text-foreground';
const checkbox = 'mt-0.5 h-5 w-5 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

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

function SessionShareFlow({ sessionId, canShare, onClose }: { sessionId: string; canShare: boolean; onClose: () => void }) {
  const { t } = useTranslation('chat');
  const auth = useOptionalAuth();
  const hasBearer = Boolean(auth?.token);
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [confirmUnattributed, setConfirmUnattributed] = useState(false);
  const [unattributedCount, setUnattributedCount] = useState(0);
  const [expiry, setExpiry] = useState<ShareExpiry>('30d');
  const [reviewed, setReviewed] = useState(false);
  const [secretsConfirmed, setSecretsConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [existing, setExisting] = useState<ShareSummary[] | null>(null);
  const [listError, setListError] = useState(false);

  useEffect(() => {
    if (!hasBearer || !canShare) return undefined;
    let cancelled = false;
    setPreview(null);
    setPreviewError(null);
    previewShare(sessionId, confirmUnattributed).then((result) => {
      if (cancelled) return;
      setPreview(result);
      setReviewed(false);
      setSecretsConfirmed(false);
      const needs = result.blockers.find((item) => item.code === NEEDS_CONFIRMATION);
      if (needs) setUnattributedCount(needs.count);
    }).catch((caught: unknown) => {
      if (!cancelled) setPreviewError(shareErrorKey(caught));
    });
    return () => { cancelled = true; };
  }, [sessionId, confirmUnattributed, revision, hasBearer, canShare]);

  const loadExisting = useCallback(async () => {
    setListError(false);
    try {
      setExisting((await listSessionShares(sessionId)).shares);
    } catch {
      setListError(true);
    }
  }, [sessionId]);

  useEffect(() => {
    if (hasBearer) void loadExisting();
  }, [hasBearer, loadExisting]);

  const hardBlockers = preview?.blockers.filter((item) => item.code !== NEEDS_CONFIRMATION) ?? [];
  const needsUnattributed = unattributedCount > 0;
  const secretCount = preview?.counts.secret ?? 0;
  const canCreate = Boolean(preview) && hardBlockers.length === 0 && reviewed && !submitting
    && (secretCount === 0 || secretsConfirmed)
    && (!needsUnattributed || (confirmUnattributed && preview?.blockers.length === 0));

  const submit = async () => {
    if (!preview || !canCreate) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await createShare(sessionId, {
        expiry, upToMessageId: preview.upToMessageId, previewSha256: preview.previewSha256,
        reviewedRedactions: true,
        ...(secretCount > 0 ? { confirmPossibleSecrets: true as const } : {}),
        ...(confirmUnattributed ? { confirmUnattributed: true } : {}),
      });
      setCreatedUrl(result.shareUrl);
      void loadExisting();
    } catch (caught) {
      setSubmitError(shareErrorKey(caught));
      if (caught instanceof ShareApiError && ['SNAPSHOT_CHANGED', 'SHARE_BLOCKED'].includes(caught.code)) {
        setRevision((value) => value + 1);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      {!hasBearer && <p role="alert" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">{t('sessionShare.noBearer')}</p>}
      {hasBearer && createdUrl && <CreatedLink url={createdUrl} />}
      {hasBearer && !createdUrl && canShare && (
        <>
          <p className="text-sm text-muted-foreground">{t('sessionShare.intro')}</p>
          {!preview && !previewError && (
            <p role="status" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> {t('sessionShare.loading')}
            </p>
          )}
          {previewError && (
            <div className="space-y-2">
              <p role="alert" className="text-sm text-danger">{t(`sessionShare.errors.${previewError}`)}</p>
              <Button type="button" variant="outline" size="sm" onClick={() => setRevision((value) => value + 1)}>{t('sessionShare.retry')}</Button>
            </div>
          )}
          {preview && (
            <>
              {hardBlockers.length > 0 && (
                <div role="alert" className="space-y-1 rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-foreground">
                  <p className="font-semibold">{t('sessionShare.blockersTitle')}</p>
                  <ul className="list-disc space-y-1 ps-5">
                    {hardBlockers.map((item) => <li key={item.code}>{t(`sessionShare.blockers.${item.code}`, { defaultValue: t('sessionShare.errors.blocked') })}</li>)}
                  </ul>
                </div>
              )}
              <RedactionSummary counts={preview.counts} />
              <SharePreviewTranscript key={preview.previewSha256} messages={preview.snapshot.messages} />
              {hardBlockers.length === 0 && (
                <div className="space-y-3">
                  {needsUnattributed && (
                    <label className={checkboxRow}>
                      <input type="checkbox" className={checkbox} checked={confirmUnattributed}
                        onChange={(event) => setConfirmUnattributed(event.target.checked)} />
                      <span>{t('sessionShare.confirmUnattributed', { n: unattributedCount })}</span>
                    </label>
                  )}
                  <div>
                    <label htmlFor="share-expiry" className="mb-1 block text-sm text-muted-foreground">{t('sessionShare.expiryLabel')}</label>
                    <select id="share-expiry" value={expiry} onChange={(event) => setExpiry(event.target.value as ShareExpiry)}
                      className="h-11 w-full rounded-md border border-input bg-background pe-8 ps-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-auto">
                      {SHARE_EXPIRIES.map((value) => <option key={value} value={value}>{t(`sessionShare.expiry.${value}`)}</option>)}
                    </select>
                  </div>
                  <label className={checkboxRow}>
                    <input type="checkbox" className={checkbox} checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />
                    <span>{t('sessionShare.reviewed')}</span>
                  </label>
                  <p className="text-xs text-muted-foreground">{t('sessionShare.reviewedNote')}</p>
                  {secretCount > 0 && (
                    <label className={checkboxRow}>
                      <input type="checkbox" className={checkbox} checked={secretsConfirmed}
                        onChange={(event) => setSecretsConfirmed(event.target.checked)} />
                      <span>{t('sessionShare.secretConfirm', { n: secretCount })}</span>
                    </label>
                  )}
                </div>
              )}
            </>
          )}
          {submitError && <p role="alert" className="text-sm text-danger">{t(`sessionShare.errors.${submitError}`)}</p>}
        </>
      )}
      {hasBearer && (
        <section aria-labelledby="share-existing-title" className="space-y-2 border-t border-border pt-3">
          <h3 id="share-existing-title" className="text-sm font-semibold text-foreground">{t('sessionShare.list.title')}</h3>
          {listError && <p role="alert" className="text-sm text-danger">{t('sessionShare.list.loadFailed')}</p>}
          {existing && (
            <ShareList shares={existing}
              onRevoked={(id) => setExisting((current) => current?.map((item) => (
                item.id === id ? { ...item, revokedAt: new Date().toISOString(), active: false } : item)) ?? null)} />
          )}
        </section>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>{createdUrl ? t('sessionShare.close') : t('sessionShare.cancel')}</Button>
        {hasBearer && canShare && !createdUrl && preview && hardBlockers.length === 0 && (
          <Button type="button" disabled={!canCreate} onClick={() => void submit()}>
            {submitting ? t('sessionShare.creating') : t('sessionShare.create')}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Share flow dialog. Its state, and so the one-time link, dies when it closes. */
export default function SessionShareDialog({ sessionId, canShare, open, onOpenChange }: Props) {
  const { t } = useTranslation('chat');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-labelledby="share-dialog-title"
        className="max-h-[92dvh] w-[calc(100vw-1rem)] max-w-2xl overflow-y-auto p-4 sm:p-6"
      >
        <h2 id="share-dialog-title" className="mb-3 text-lg font-semibold text-foreground">{t('sessionShare.dialogTitle')}</h2>
        <SessionShareFlow sessionId={sessionId} canShare={canShare} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
