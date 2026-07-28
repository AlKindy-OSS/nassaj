import ReactDOM from 'react-dom';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../shared/view/ui';
import type { TerminalSummary } from '../../types/types';

type TerminalDeleteConfirmModalProps = {
  /** The running terminal pending deletion, or null when the modal is closed. */
  terminal: TerminalSummary | null;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Confirmation gate before killing a RUNNING terminal (kills the PTY and drops
 * its buffer). Matches the app's existing delete dialogs (portal + destructive
 * button). Exited terminals are deleted without a prompt by the caller.
 */
export default function TerminalDeleteConfirmModal({
  terminal,
  onConfirm,
  onCancel,
}: TerminalDeleteConfirmModalProps) {
  const { t } = useTranslation('terminals');

  if (!terminal) {
    return null;
  }

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="p-6">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
              <AlertTriangle className="h-6 w-6 text-red-600 dark:text-red-400" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="mb-2 text-lg font-semibold text-foreground">{t('deleteConfirm.title')}</h3>
              <p className="mb-1 text-sm text-muted-foreground">
                {t('deleteConfirm.message')}{' '}
                <span className="font-medium text-foreground" dir="auto">
                  {terminal.title}
                </span>
                ?
              </p>
              <p className="mt-3 text-xs text-muted-foreground">{t('deleteConfirm.warning')}</p>
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-2 border-t border-border bg-muted/30 p-4">
          <Button
            variant="destructive"
            className="w-full justify-start bg-red-600 text-white hover:bg-red-700"
            onClick={onConfirm}
          >
            <Trash2 className="me-2 h-4 w-4" />
            {t('deleteConfirm.confirm')}
          </Button>
          <Button variant="ghost" className="w-full" onClick={onCancel}>
            {t('deleteConfirm.cancel')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
