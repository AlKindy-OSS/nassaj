import { useTranslation } from 'react-i18next';
import type { WsConnectionStatus } from '../../../../contexts/WebSocketContext';

interface WsConnectionBadgeProps {
  status: WsConnectionStatus;
}

/**
 * Compact status badge shown in the chat header when the WebSocket is not
 * fully connected.  RTL-aware: uses logical margin (ms-) so it sits correctly
 * in both LTR and RTL layouts.
 *
 * Visible only in "reconnecting" and "disconnected" states; renders nothing
 * while fully connected so the happy-path UI is unchanged.
 */
export default function WsConnectionBadge({ status }: WsConnectionBadgeProps) {
  const { t } = useTranslation('chat');

  if (status === 'connected') return null;

  const isReconnecting = status === 'reconnecting';

  const label = isReconnecting
    ? t('ws.statusReconnecting', { defaultValue: 'Reconnecting…' })
    : t('ws.statusDisconnected', { defaultValue: 'Disconnected' });

  const ariaLabel = isReconnecting
    ? t('ws.ariaReconnecting', { defaultValue: 'WebSocket reconnecting' })
    : t('ws.ariaDisconnected', { defaultValue: 'WebSocket disconnected' });

  return (
    <div
      role="status"
      aria-label={ariaLabel}
      className={[
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium',
        isReconnecting
          ? 'border-yellow-300/60 bg-yellow-50 text-yellow-700 dark:border-yellow-600/40 dark:bg-yellow-900/15 dark:text-yellow-300'
          : 'border-red-300/60 bg-red-50 text-red-700 dark:border-red-600/40 dark:bg-red-900/15 dark:text-red-300',
      ].join(' ')}
    >
      {/* Dot indicator */}
      <span
        className={[
          'h-1.5 w-1.5 rounded-full',
          isReconnecting ? 'animate-pulse bg-yellow-500' : 'bg-red-500',
        ].join(' ')}
        aria-hidden="true"
      />
      {label}
    </div>
  );
}
