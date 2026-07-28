import { AlertTriangle, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useTerminalConnection } from '../../hooks/useTerminalConnection';
import type { TerminalSummary } from '../../types/types';

type TerminalViewProps = {
  terminal: TerminalSummary;
  isActive: boolean;
  onRequestListRefresh: () => void;
};

/**
 * Renders one attached terminal (T-939). Mounted with `key={terminal.id}` by the
 * panel, so switching terminals gives a clean xterm lifecycle while the server
 * keeps every PTY alive. The xterm host is `dir="ltr"` inside RTL chrome.
 */
export default function TerminalView({ terminal, isActive, onRequestListRefresh }: TerminalViewProps) {
  const { t } = useTranslation('terminals');
  const { terminalContainerRef, state, truncated, exitInfo, errorMessage, reconnect } = useTerminalConnection({
    terminalId: terminal.id,
    initialStatus: terminal.status,
    isActive,
    onRequestListRefresh,
  });

  const isExited = state === 'exited' || terminal.status === 'exited';
  const exitCode = exitInfo?.exitCode ?? terminal.exitCode;
  const exitSignal = exitInfo?.signal ?? terminal.signal;
  const exitedLabel = exitSignal
    ? t('status.exitedSignal', { signal: exitSignal })
    : t('status.exited', { code: exitCode ?? 0 });

  // Blocking states (a fresh attach is possible/required) render a centered card.
  const blockingState =
    state === 'superseded' || state === 'serverRestart' || state === 'notFound' || state === 'error';

  const blockingMessage =
    state === 'superseded'
      ? t('status.openedElsewhere')
      : state === 'serverRestart'
        ? t('status.serverRestart')
        : state === 'notFound'
          ? t('status.notFound')
          : errorMessage || t('status.error');

  const canReconnect = state === 'superseded' || state === 'serverRestart' || state === 'error';

  return (
    <div className="flex h-full w-full flex-col bg-gray-900">
      {truncated && (
        <div className="flex-shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1 text-center text-[11px] text-amber-300">
          {t('status.truncated')}
        </div>
      )}

      {isExited && (
        <div className="flex flex-shrink-0 items-center justify-center gap-1.5 border-b border-gray-700/60 bg-gray-800/80 px-3 py-1 text-[11px] text-gray-300">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-gray-500" aria-hidden="true" />
          <span>{exitedLabel}</span>
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden p-2">
        <div
          ref={terminalContainerRef}
          dir="ltr"
          className="h-full w-full focus:outline-none"
          style={{ outline: 'none' }}
        />

        {state === 'connecting' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="rounded-full bg-gray-800/90 px-3 py-1 text-xs text-gray-300">
              {t('status.connecting')}
            </span>
          </div>
        )}

        {/* Non-blocking: the prior output stays visible under the badge while we
            re-attach to the live PTY, which replays the buffer on success. */}
        {state === 'reconnecting' && (
          <div className="pointer-events-none absolute inset-x-0 top-2 flex justify-center">
            <span
              role="status"
              className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-3 py-1 text-xs text-amber-300"
            >
              <RotateCcw className="h-3 w-3 animate-spin" aria-hidden="true" />
              {t('status.reconnecting')}
            </span>
          </div>
        )}

        {blockingState && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900/85 backdrop-blur-sm">
            <div className="mx-4 max-w-sm rounded-2xl border border-gray-700 bg-gray-800/90 px-6 py-5 text-center">
              <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-gray-700/70">
                <AlertTriangle className="h-5 w-5 text-amber-400" aria-hidden="true" />
              </div>
              <p className="mb-4 text-sm leading-relaxed text-gray-200">{blockingMessage}</p>
              {canReconnect && (
                <button
                  type="button"
                  onClick={reconnect}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('status.openedElsewhereAction')}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
