import { Compass, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';

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
      data-steer-starter-notice=""
      className="mx-3 mb-1 flex min-h-8 items-center gap-1.5 text-xs text-[color:var(--session-steer-accent)] sm:mx-0"
    >
      <Compass className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">
        {/* FSI/PDI عزل ثنائي الاتجاه مكافئ لـ bdi داخل نصّ مترجَم */}
        {t('steer.starterNotice.text', {
          name: `\u2068${senderName}\u2069`,
          defaultValue: '{{name}} steered this run',
        })}
      </span>
      {canStopTurn && (
        <>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={onStopTurn}
            className="inline-flex min-h-8 flex-shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--session-steer-accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          >
            <Square className="h-3 w-3" aria-hidden="true" />
            {t('steer.starterNotice.stopTurn', { defaultValue: 'Stop turn' })}
          </button>
        </>
      )}
    </div>
  );
}
