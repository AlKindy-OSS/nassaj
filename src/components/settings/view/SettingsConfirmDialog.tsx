import { useEffect, useId, useRef, type ReactNode } from 'react';

import { Button, Dialog, DialogContent, DialogTitle } from '../../../shared/view/ui';

type SettingsConfirmDialogProps = {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** The action moves money or destroys something: red confirm button. */
  destructive?: boolean;
  confirmDisabled?: boolean;
  busy?: boolean;
};

/**
 * The one confirm dialog of the vendor-key surface (ADR-200 S9). Pattern of
 * `HarnessUpdateConfirmDialog`: title, body, a button row. Differences that
 * matter for a destructive or billing-relevant action:
 *
 *  - focus lands on Cancel, not on the dialog container, so a stray Enter
 *    cancels instead of confirming;
 *  - Esc and the overlay cancel (the shared `Dialog` already does both) and
 *    focus returns to the trigger when it closes.
 */
export default function SettingsConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  destructive = false,
  confirmDisabled = false,
  busy = false,
}: SettingsConfirmDialogProps) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  // `Dialog` focuses its own container on the next frame; focus Cancel one frame later.
  useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => cancelRef.current?.focus());
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, []);

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent layerClassName="z-[10000]" className="max-w-md p-4" aria-labelledby={titleId}>
        <DialogTitle id={titleId} className="not-sr-only text-[15px] font-medium text-foreground">
          {title}
        </DialogTitle>
        <div className="mt-3 space-y-3 text-[13px] leading-relaxed text-foreground">{children}</div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button ref={cancelRef} type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={destructive ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
