import { useCallback, useEffect, useState } from 'react';
import { Eye } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { SHARES_CHANGED_EVENT, ShareApiError, getShareStatus } from './sessionShareApi';

const POLL_MS = 60_000;

type Props = { sessionId: string };

/**
 * In-session notice shown to every member while a public live read link is
 * active (ADR-205 D5). Polls the status route every 60 s while the tab is
 * visible and refreshes right after a create or revoke. A refused or failed
 * poll keeps the last known value: a 429 must never hide an active link.
 */
export default function SessionShareNotice({ sessionId }: Props) {
  const { t } = useTranslation('chat');
  const [active, setActive] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const { activeLiveLinks } = await getShareStatus(sessionId);
      setActive(Number.isFinite(activeLiveLinks) ? activeLiveLinks : 0);
    } catch (caught) {
      if (caught instanceof ShareApiError && (caught.status === 401 || caught.status === 404)) setActive(0);
    }
  }, [sessionId]);

  useEffect(() => {
    setActive(0);
    let cancelled = false;
    const run = () => { if (!cancelled && document.visibilityState !== 'hidden') void refresh(); };
    run();
    const timer = window.setInterval(run, POLL_MS);
    const onChanged = () => run();
    window.addEventListener(SHARES_CHANGED_EVENT, onChanged);
    document.addEventListener('visibilitychange', onChanged);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener(SHARES_CHANGED_EVENT, onChanged);
      document.removeEventListener('visibilitychange', onChanged);
    };
  }, [refresh]);

  if (active <= 0) return null;
  const full = t('sessionShare.notice.full');
  return (
    <span
      role="status" title={full} aria-label={full}
      className="inline-flex min-h-7 max-w-56 items-center gap-1 rounded-md border border-warning/40 bg-warning/10 px-1.5 text-[11px] text-foreground"
    >
      <Eye className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="hidden truncate sm:inline">{t('sessionShare.notice.short')}</span>
    </span>
  );
}
