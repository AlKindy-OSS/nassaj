import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PlayIcon } from 'lucide-react';

import {
  useSessionPermissionFence,
  type AcknowledgeErrorKey,
} from '../../hooks/useSessionPermissionFence';

interface ContinueHerePanelProps {
  sessionId: string;
  /** يُستدعى بعد رفع الحجب فعلاً؛ المستدعي يُخفي البطاقة ويعيد النصّ للمُؤلِّف. */
  onLifted: () => void;
}

const BUTTON_CLASS =
  'inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/60 px-2 py-1 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-60';

/**
 * T-1910 S4 — «أكمل من هنا» على بطاقة الجلسة المحجوبة. لا يُعرض شيء إلا إذا
 * أكّد الخادم حجباً بنطاق `session`؛ نطاقٌ آخر يبقى على رابط المالك للإعدادات.
 */
export default function ContinueHerePanel({ sessionId, onLifted }: ContinueHerePanelProps) {
  const { t } = useTranslation('chat');
  const { fence, busy, acknowledge } = useSessionPermissionFence(sessionId, true);
  const [confirming, setConfirming] = useState(false);
  const [errorKey, setErrorKey] = useState<AcknowledgeErrorKey | null>(null);

  if (!fence?.fenced || fence.scope !== 'session') return null;

  if (!fence.canAcknowledge) {
    return (
      <p className="mt-2 text-xs opacity-90" data-testid="continue-here-member-notice">
        {t('outbox.continueHere.memberNotice')}
      </p>
    );
  }

  // لا يُعرض الزرّ حيث لا يُرفع الحجب من هنا أبداً: يرفعه المالك من الإعدادات.
  if (fence.containment === 'not_provable') {
    return (
      <p className="mt-2 text-xs opacity-90" data-testid="continue-here-not-provable">
        {t('outbox.continueHere.error.not_provable')}
      </p>
    );
  }

  const confirmLift = async () => {
    setErrorKey(null);
    const result = await acknowledge();
    if (result.ok) {
      onLifted();
      return;
    }
    setConfirming(false);
    setErrorKey(result.errorKey);
  };

  return (
    <div className="mt-2 text-xs" data-testid="continue-here-panel">
      <p>{t('outbox.continueHere.notice')}</p>

      {confirming ? (
        <div role="group" aria-label={t('outbox.continueHere.action')} className="mt-2 flex flex-wrap items-center gap-2">
          <span className="min-w-0 break-words">{t('outbox.continueHere.confirmPrompt')}</span>
          <button type="button" disabled={busy} onClick={confirmLift} className={BUTTON_CLASS}>
            {busy ? t('outbox.continueHere.working') : t('outbox.continueHere.confirm')}
          </button>
          <button type="button" disabled={busy} onClick={() => setConfirming(false)} className={BUTTON_CLASS}>
            {t('outbox.continueHere.cancel')}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className={`mt-2 ${BUTTON_CLASS}`}
        >
          <PlayIcon className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
          {t('outbox.continueHere.action')}
        </button>
      )}

      {errorKey && (
        <p role="alert" className="mt-2 font-medium" data-testid="continue-here-error">
          {t(`outbox.continueHere.error.${errorKey}`)}
        </p>
      )}
    </div>
  );
}
