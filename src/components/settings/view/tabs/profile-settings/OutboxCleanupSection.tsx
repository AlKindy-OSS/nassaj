import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ClipboardCopy, Inbox, Loader2 } from 'lucide-react';

import { Button } from '../../../../../shared/view/ui';
import {
  createStuckOutboxDismissal,
  getOutboxSnapshot,
  selectStuckOutboxEntries,
  subscribeOutbox,
} from '../../../../chat/utils/messageOutbox';
import { getSessionProcessState } from '../../../../../stores/sessionProcessStateStore';
import SettingsCard from '../../SettingsCard';
import SettingsSection from '../../SettingsSection';

import FeedbackBanner from './FeedbackBanner';
import type { Feedback } from './FeedbackBanner';

/** A session counts as "live" globally — not only the one currently open — so a
 * pending entry from another chat is never mistaken for stuck while its round
 * is still running. 'frozen' (kill -STOP) is a paused process, not a dead one. */
function isSessionLive(sessionId: string | null): boolean {
  if (!sessionId) return false;
  const state = getSessionProcessState(sessionId);
  return state === 'running' || state === 'frozen';
}

/** Recomputed every 30s so an entry that crosses the staleness bound while this
 * panel sits open updates the count without requiring a store write. */
const RECHECK_INTERVAL_MS = 30 * 1000;
/** The success banner reads as a toast: it clears itself instead of lingering. */
const SUCCESS_AUTO_CLEAR_MS = 6 * 1000;

type PendingCleanup = { count: number; texts: string[]; commit: () => Promise<number> };

/**
 * T-1382/B-1370 — تنظيف الرسائل العالقة في صندوق الصادر المحلي (الإعدادات).
 *
 * المشكلة: `outbox.storageFull` يمنع الإرسال حين يمتلئ صندوق الحساب بـ
 * `failed`/`unconfirmed`/`pending` يتيمة من محادثاتٍ أخرى — ولا فعل واجهة كان
 * يُخليها (`createDeliveredOutboxDismissal` يخصّ `delivered` وحدها). هذا القسم
 * يتيح إخلاءها صراحةً بإذن المستخدم، مع فرصة نسخ نصوصها أولاً.
 */
export default function OutboxCleanupSection() {
  const { t } = useTranslation('settings');
  const entries = useSyncExternalStore(subscribeOutbox, getOutboxSnapshot);
  const [now, setNow] = useState(() => Date.now());
  const [pending, setPending] = useState<PendingCleanup | null>(null);
  const [busy, setBusy] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<Feedback>(null);
  const [resultFeedback, setResultFeedback] = useState<Feedback>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), RECHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!resultFeedback) return;
    const id = setTimeout(() => setResultFeedback(null), SUCCESS_AUTO_CLEAR_MS);
    return () => clearTimeout(id);
  }, [resultFeedback]);

  const stuckCount = useMemo(
    () => selectStuckOutboxEntries(entries, { now, isSessionLive }).length,
    [entries, now],
  );

  const openConfirm = useCallback(() => {
    setResultFeedback(null);
    setCopyFeedback(null);
    setPending(createStuckOutboxDismissal(isSessionLive, Date.now()));
  }, []);

  const cancel = useCallback(() => {
    setPending(null);
    setCopyFeedback(null);
  }, []);

  const copyTexts = useCallback(async () => {
    if (!pending || pending.texts.length === 0) return;
    try {
      await navigator.clipboard.writeText(pending.texts.join('\n\n'));
      setCopyFeedback({ kind: 'success', message: t('profile.outboxCleanup.copySuccess') });
    } catch {
      setCopyFeedback({ kind: 'error', message: t('profile.outboxCleanup.copyFailed') });
    }
  }, [pending, t]);

  const confirmCleanup = useCallback(async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const removed = await pending.commit();
      setResultFeedback({ kind: 'success', message: t('profile.outboxCleanup.success', { count: removed }) });
    } finally {
      setBusy(false);
      setPending(null);
      setCopyFeedback(null);
    }
  }, [pending, t]);

  return (
    <SettingsSection
      boxed
      icon={Inbox}
      title={t('profile.outboxCleanup.title')}
      description={t('profile.outboxCleanup.description')}
    >
      <div className="space-y-3 py-2">
        {!pending && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {stuckCount === 0
                ? t('profile.outboxCleanup.none')
                : t('profile.outboxCleanup.count', { count: stuckCount })}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={stuckCount === 0}
              onClick={openConfirm}
            >
              {t('profile.outboxCleanup.start')}
            </Button>
          </div>
        )}

        {pending && (
          <div
            role="alertdialog"
            aria-labelledby="outbox-cleanup-confirm-title"
            className="space-y-3"
          >
            <SettingsCard tone="warning">
              <div className="space-y-2 text-[13px] leading-relaxed text-foreground">
                <p id="outbox-cleanup-confirm-title" className="flex items-start gap-2 font-medium">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-warning" aria-hidden="true" />
                  <span>{t('profile.outboxCleanup.confirmCount', { count: pending.count })}</span>
                </p>
                <p className="text-muted-foreground">{t('profile.outboxCleanup.confirmWarning')}</p>
              </div>
            </SettingsCard>

            <FeedbackBanner feedback={copyFeedback} />

            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void copyTexts()}
                disabled={busy || pending.texts.length === 0}
              >
                <ClipboardCopy className="h-4 w-4" aria-hidden="true" />
                {t('profile.outboxCleanup.copyTexts')}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={cancel} disabled={busy}>
                {t('profile.outboxCleanup.cancel')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => void confirmCleanup()}
                disabled={busy}
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                {t('profile.outboxCleanup.confirm')}
              </Button>
            </div>
          </div>
        )}

        <FeedbackBanner feedback={resultFeedback} />
      </div>
    </SettingsSection>
  );
}
