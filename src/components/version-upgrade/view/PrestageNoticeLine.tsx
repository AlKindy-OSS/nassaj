import { useTranslation } from 'react-i18next';
import { CheckCircle2, Clock, Loader2 } from 'lucide-react';

import { formatPrestageTime, prestageNotice, type PrestageStatus } from '../prestageStatus';

interface PrestageNoticeLineProps {
  prestage: PrestageStatus | null | undefined;
  latestVersion: string | null;
}

/**
 * ADR-207 (T-2024 S5): one quiet line on whether the offered release is
 * already prepared in the background. Informational only — it never gates the
 * update button, and it never prints a reason code.
 */
export function PrestageNoticeLine({ prestage, latestVersion }: PrestageNoticeLineProps) {
  const { t, i18n } = useTranslation('common');
  const notice = prestageNotice(prestage, latestVersion);
  if (!notice) return null;

  const ready = notice.tone === 'ready';
  const building = notice.key === 'versionUpdate.prestage.building';
  const text = notice.until
    ? t(notice.key, { time: formatPrestageTime(notice.until, i18n.language) })
    : t(notice.key);
  const Icon = ready ? CheckCircle2 : building ? Loader2 : Clock;

  return (
    <p
      role="status"
      data-prestage-tone={notice.tone}
      className={`flex items-center gap-1.5 text-xs ${ready
        ? 'text-green-700 dark:text-green-300'
        : 'text-muted-foreground'}`}
    >
      <Icon
        aria-hidden="true"
        className={`h-3.5 w-3.5 shrink-0 ${ready ? 'text-green-600 dark:text-green-400' : ''} ${building
          ? 'animate-spin motion-reduce:animate-none' : ''}`}
      />
      <span>{text}</span>
    </p>
  );
}
