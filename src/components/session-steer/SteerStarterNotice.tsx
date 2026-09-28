import { Compass, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../shared/view/ui';

export interface SteerStarterNoticeProps {
  senderName: string;
  onStopTurn: () => void;
  canStopTurn: boolean;
}

/**
 * T-1903 (ADR-190) — تنبيه غير-حاجب لبادئ الدور عند وصول توجيه من عضوٍ آخر.
 * لا يوقف شيئاً بنفسه: زرّ الإيقاف يستدعي مسار الإحباط (abort) القائم نفسه.
 */
export default function SteerStarterNotice({ senderName, onStopTurn, canStopTurn }: SteerStarterNoticeProps) {
  const { t } = useTranslation('chat');

  return (
    <div
      role="status"
      className="border-[color:var(--session-steer-accent)]/40 bg-[color:var(--session-steer-accent)]/10 mx-3 mb-2 flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm sm:mx-0"
    >
      <span className="flex min-w-0 items-center gap-2 text-foreground">
        <Compass className="h-4 w-4 flex-shrink-0 text-[color:var(--session-steer-accent)]" aria-hidden="true" />
        <span className="truncate">
          {t('steer.starterNotice.text', { name: senderName, defaultValue: '{{name}} steered this run' })}
        </span>
      </span>
      {canStopTurn && (
        <Button type="button" size="sm" variant="outline" onClick={onStopTurn}>
          <Square className="h-3.5 w-3.5" aria-hidden="true" />
          {t('steer.starterNotice.stopTurn', { defaultValue: 'Stop turn' })}
        </Button>
      )}
    </div>
  );
}
