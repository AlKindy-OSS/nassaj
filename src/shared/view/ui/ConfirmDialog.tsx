import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';

import { cn } from '../../../lib/utils';

import { Button } from './Button';
import { Dialog, DialogContent, DialogTitle } from './Dialog';

export type ConfirmDialogTone = 'default' | 'danger';

export interface ConfirmDialogProps {
  /** `alert` shows only the primary (OK) button. */
  variant?: 'confirm' | 'alert';
  title?: string;
  message: string;
  /** Verbatim LTR monospace block under the message (commands, snippets). */
  code?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger`: destructive primary button, and Cancel takes initial focus. */
  tone?: ConfirmDialogTone;
  onConfirm: () => void;
  /** Cancel button, Escape and the overlay all call this. */
  onCancel: () => void;
}

/**
 * Themed, RTL-aware replacement for the native confirm/alert box (T-2039).
 * Built on the shared `Dialog` (portal, focus trap, Escape, focus restore) as
 * an `alertdialog`. Initial focus goes to Cancel for a destructive question
 * (a stray Enter cancels) and to the primary button otherwise. The button row
 * is ordered logically: the primary action sits at the inline end.
 */
export function ConfirmDialog({
  variant = 'confirm',
  title,
  message,
  code,
  confirmLabel,
  cancelLabel,
  tone = 'default',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation('common');
  const titleId = useId();
  const messageId = useId();
  const codeId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const isAlert = variant === 'alert';
  const isDanger = tone === 'danger';

  // DialogHost mounts one ConfirmDialog per request and unmounts it on settle,
  // so `Dialog`'s open→false restore never runs (T-2039 qa). Capture the opener
  // before focus moves in and give it back on unmount. With a queue, the next
  // dialog mounts after this cleanup and so captures the same opener.
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (opener && opener.isConnected && opener !== document.body) opener.focus();
    };
  }, []);

  // `Dialog` focuses its container on the next frame; move focus one frame later.
  useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        const target = isDanger && !isAlert ? cancelRef.current : primaryRef.current;
        target?.focus();
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [isAlert, isDanger]);

  const primaryLabel = confirmLabel ?? (isAlert ? t('dialog.ok') : t('dialog.confirm'));

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent
        role="alertdialog"
        layerClassName="z-[10050]"
        className="w-[calc(100%-2rem)] max-w-md p-5"
        aria-labelledby={title ? titleId : messageId}
        aria-describedby={
          [title ? messageId : null, code ? codeId : null].filter(Boolean).join(' ') || undefined
        }
        data-testid="confirm-dialog"
      >
        <div className="flex items-start gap-3">
          {isDanger && (
            <span
              className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive"
              aria-hidden
            >
              <AlertTriangle className="size-4" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            {title && (
              <DialogTitle id={titleId} className="not-sr-only mb-2 text-base font-semibold text-foreground">
                {title}
              </DialogTitle>
            )}
            <p
              id={messageId}
              className={cn(
                'whitespace-pre-line break-words text-sm leading-relaxed',
                title ? 'text-muted-foreground' : 'text-foreground',
              )}
            >
              {message}
            </p>
            {code && (
              <pre
                id={codeId}
                dir="ltr"
                data-testid="confirm-dialog-code"
                className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted px-3 py-2 text-start font-mono text-xs leading-5 text-foreground"
              >
                <code>{code}</code>
              </pre>
            )}
          </div>
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          {!isAlert && (
            <Button ref={cancelRef} type="button" variant="outline" size="sm" onClick={onCancel}>
              {cancelLabel ?? t('dialog.cancel')}
            </Button>
          )}
          <Button
            ref={primaryRef}
            type="button"
            size="sm"
            variant={isDanger && !isAlert ? 'destructive' : 'default'}
            onClick={onConfirm}
          >
            {primaryLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default ConfirmDialog;
