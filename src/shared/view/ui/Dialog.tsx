import * as React from 'react';
import { createPortal } from 'react-dom';

import { cn } from '../../../lib/utils';

interface DialogContextValue {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: React.MutableRefObject<HTMLElement | null>;
  /** Id of the mounted DialogTitle (null when none): the content's accessible name. */
  titleId: string | null;
  setTitleId: (id: string | null) => void;
  /** Id of the mounted DialogDescription (null when none). */
  descriptionId: string | null;
  setDescriptionId: (id: string | null) => void;
}

const DialogContext = React.createContext<DialogContextValue | null>(null);

function useDialog() {
  const ctx = React.useContext(DialogContext);
  if (!ctx) throw new Error('Dialog components must be used within <Dialog>');
  return ctx;
}

interface DialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

const Dialog: React.FC<DialogProps> = ({ open: controlledOpen, onOpenChange: controlledOnOpenChange, defaultOpen = false, children }) => {
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const triggerRef = React.useRef<HTMLElement | null>(null) as React.MutableRefObject<HTMLElement | null>;
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const onOpenChange = React.useCallback(
    (next: boolean) => {
      if (!isControlled) setInternalOpen(next);
      controlledOnOpenChange?.(next);
    },
    [isControlled, controlledOnOpenChange]
  );

  const [titleId, setTitleId] = React.useState<string | null>(null);
  const [descriptionId, setDescriptionId] = React.useState<string | null>(null);
  const value = React.useMemo(
    () => ({ open, onOpenChange, triggerRef, titleId, setTitleId, descriptionId, setDescriptionId }),
    [open, onOpenChange, titleId, descriptionId],
  );

  return <DialogContext.Provider value={value}>{children}</DialogContext.Provider>;
};

const DialogTrigger = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }>(
  ({ onClick, children, asChild, ...props }, ref) => {
    const { onOpenChange, triggerRef } = useDialog();

    const handleClick = React.useCallback(
      (e: React.MouseEvent<HTMLButtonElement>) => {
        onOpenChange(true);
        onClick?.(e);
      },
      [onOpenChange, onClick]
    );

    // asChild: clone child element and compose onClick + capture ref
    if (asChild && React.isValidElement(children)) {
      const child = children as React.ReactElement<any>;
      return React.cloneElement(child, {
        onClick: (e: React.MouseEvent<HTMLElement>) => {
          onOpenChange(true);
          child.props.onClick?.(e);
        },
        ref: (node: HTMLElement | null) => {
          triggerRef.current = node;
          // Forward the outer ref
          if (typeof ref === 'function') ref(node as any);
          else if (ref) (ref as React.MutableRefObject<any>).current = node;
        },
      });
    }

    return (
      <button
        ref={(node) => {
          triggerRef.current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) ref.current = node;
        }}
        type="button"
        onClick={handleClick}
        {...props}
      >
        {children}
      </button>
    );
  }
);
DialogTrigger.displayName = 'DialogTrigger';

interface DialogContentProps extends React.HTMLAttributes<HTMLDivElement> {
  /** A nested dialog may sit above its existing editor overlay. */
  layerClassName?: string;
  /**
   * Runs before Escape closes the dialog. Calling `event.preventDefault()` keeps
   * the dialog open and lets the key reach the focused element (e.g. to leave
   * an inner step first).
   */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onPointerDownOutside?: () => void;
}

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const DialogContent = React.forwardRef<HTMLDivElement, DialogContentProps>(
  ({ className, layerClassName, children, onEscapeKeyDown, onPointerDownOutside, ...props }, ref) => {
    const { open, onOpenChange, triggerRef, titleId, descriptionId } = useDialog();
    const contentRef = React.useRef<HTMLDivElement | null>(null);
    const previousFocusRef = React.useRef<HTMLElement | null>(null);

    // Save the element that had focus before opening, restore on close
    React.useEffect(() => {
      if (open) {
        previousFocusRef.current = document.activeElement as HTMLElement;
      } else if (previousFocusRef.current) {
        // Prefer the trigger, fall back to whatever was focused before
        const restoreTarget = triggerRef.current || previousFocusRef.current;
        restoreTarget?.focus();
        previousFocusRef.current = null;
      }
    }, [open, triggerRef]);

    React.useEffect(() => {
      if (!open) return;

      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          onEscapeKeyDown?.(e);
          if (e.defaultPrevented) return;
          e.stopPropagation();
          onOpenChange(false);
          return;
        }

        // Focus trap: Tab / Shift+Tab cycle within the dialog.
        // Also handles the case where focus is on the container itself (tabIndex={-1})
        // after auto-focus on open — Shift+Tab from container wraps to last element.
        if (e.key === 'Tab' && contentRef.current) {
          const focusable = Array.from(
            contentRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
          );
          if (focusable.length === 0) return;

          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          const isOnContainer = document.activeElement === contentRef.current;

          if (e.shiftKey && (document.activeElement === first || isOnContainer)) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      };

      document.addEventListener('keydown', handleKeyDown, true);

      // Prevent body scroll
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';

      return () => {
        document.removeEventListener('keydown', handleKeyDown, true);
        document.body.style.overflow = prev;
      };
    }, [open, onOpenChange, onEscapeKeyDown]);

    // Auto-focus the dialog container on open (not the first interactive child).
    // Focusing the container (tabIndex={-1}) keeps focus inside the dialog without
    // triggering a focus ring on the first button — the user sees no ring until they
    // actively Tab/click. The focus trap above handles Shift+Tab from the container.
    React.useEffect(() => {
      if (open && contentRef.current) {
        // Small delay to let the portal render
        requestAnimationFrame(() => {
          contentRef.current?.focus();
        });
      }
    }, [open]);

    if (!open) return null;

    return createPortal(
      <div className={cn('fixed inset-0 z-50', layerClassName)}>
        {/* Overlay */}
        <div
          className="fixed inset-0 animate-dialog-overlay-show bg-black/50 backdrop-blur-sm"
          onClick={() => {
            onPointerDownOutside?.();
            onOpenChange(false);
          }}
          aria-hidden
        />
        {/* Content */}
        <div
          ref={(node) => {
            contentRef.current = node;
            if (typeof ref === 'function') ref(node);
            else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
          }}
          role="dialog"
          aria-modal="true"
          // tabIndex={-1} makes the container programmatically focusable so auto-focus
          // lands here (not on the first button). outline-none suppresses the browser's
          // default ring on this container — user-visible focus rings live on interactive
          // children via focus-visible:ring-* utilities.
          tabIndex={-1}
          aria-labelledby={props['aria-label'] ? undefined : titleId ?? undefined}
          aria-describedby={descriptionId ?? undefined}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2',
            'rounded-xl border bg-popover text-popover-foreground shadow-lg',
            'animate-dialog-content-show outline-none',
            className
          )}
          {...props}
        >
          {children}
        </div>
      </div>,
      document.body
    );
  }
);
DialogContent.displayName = 'DialogContent';

/** Registers an element id with the dialog while mounted; returns the id to render. */
function useRegisteredId(given: string | undefined, register: (id: string | null) => void): string {
  const generated = React.useId();
  const id = given ?? generated;
  React.useLayoutEffect(() => {
    register(id);
    return () => register(null);
  }, [id, register]);
  return id;
}

/** The dialog's heading; its id names the dialog (aria-labelledby). Visually hidden unless overridden. */
const DialogTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, id, ...props }, ref) => {
    const { setTitleId } = useDialog();
    const titleId = useRegisteredId(id, setTitleId);
    return <h2 ref={ref} id={titleId} className={cn('sr-only', className)} {...props} />;
  }
);
DialogTitle.displayName = 'DialogTitle';

/** Optional supporting text; its id describes the dialog (aria-describedby). */
const DialogDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ id, ...props }, ref) => {
    const { setDescriptionId } = useDialog();
    const descriptionId = useRegisteredId(id, setDescriptionId);
    return <p ref={ref} id={descriptionId} {...props} />;
  }
);
DialogDescription.displayName = 'DialogDescription';

export { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription, useDialog };
