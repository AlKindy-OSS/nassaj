import * as React from 'react';
import { ChevronDown, Loader2, type LucideIcon } from 'lucide-react';

import { cn } from '../../../lib/utils';

import { Button } from './Button';

type ButtonVariant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
type ButtonSize = 'default' | 'sm' | 'lg' | 'icon';

export type ActionMenuItem = {
  key: string;
  label: string;
  description?: string;
  icon?: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  loading?: boolean;
  isDanger?: boolean;
  showDividerBefore?: boolean;
};

type ActionMenuProps = {
  label: string;
  triggerContent?: React.ReactNode;
  side?: 'top' | 'bottom';
  items: ActionMenuItem[];
  icon?: LucideIcon;
  ariaLabel?: string;
  align?: 'start' | 'end';
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  triggerClassName?: string;
  disabled?: boolean;
};

export default function ActionMenu({
  label,
  triggerContent,
  side = 'bottom',
  items,
  icon: TriggerIcon,
  ariaLabel,
  align = 'end',
  variant = 'outline',
  size = 'sm',
  className,
  triggerClassName,
  disabled,
}: ActionMenuProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  // isClosing: menu is still visible but playing exit animation before unmount.
  const [isClosing, setIsClosing] = React.useState(false);
  const closeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  // Whether closing should move focus back to the trigger. Set for keyboard
  // (Escape) and item selection, but left false for outside pointer clicks so
  // focus is not stolen from wherever the user clicked.
  const restoreFocusRef = React.useRef(false);
  // True only when the menu was opened with an arrow key: then the first item
  // takes focus. A pointer click leaves focus on the menu container so no item
  // appears pre-selected on open.
  const openedByArrowKeyRef = React.useRef(false);
  const wasOpenRef = React.useRef(false);
  const menuId = React.useId();

  // Trigger the exit animation then unmount. restoreFocus decides whether
  // keyboard focus returns to the trigger button after the menu disappears.
  const beginClose = React.useCallback((restoreFocus: boolean) => {
    restoreFocusRef.current = restoreFocus;
    if (closeTimerRef.current !== null) return; // already closing
    setIsClosing(true);
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setIsClosing(false);
      setIsOpen(false);
    }, 120);
  }, []);

  // Clean up the timer if the component unmounts while animating out.
  React.useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    };
  }, []);

  React.useEffect(() => {
    if (!isOpen) {
      return;
    }

    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current && !rootRef.current.contains(target)) {
        beginClose(false);
      }
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        beginClose(true);
      }
    };

    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen, beginClose]);

  // Move focus into the menu on open and back to the trigger on a keyboard or
  // selection close, so keyboard and screen-reader navigation match the menu role.
  React.useEffect(() => {
    if (isOpen) {
      wasOpenRef.current = true;
      const menu = menuRef.current;
      const firstItem = openedByArrowKeyRef.current
        ? menu?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')
        : null;
      openedByArrowKeyRef.current = false;
      (firstItem ?? menu)?.focus();
      return;
    }

    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      if (restoreFocusRef.current) {
        triggerRef.current?.focus();
      }
      restoreFocusRef.current = false;
    }
  }, [isOpen]);

  const runItem = (item: ActionMenuItem) => {
    if (item.disabled || item.loading) {
      return;
    }

    beginClose(true);
    item.onSelect();
  };

  return (
    <div ref={rootRef} className={cn('relative inline-flex', className)}>
      <Button
        ref={triggerRef}
        type="button"
        variant={variant}
        size={size}
        className={triggerClassName}
        disabled={disabled}
        aria-label={ariaLabel || label}
        aria-haspopup="menu"
        aria-expanded={isOpen && !isClosing}
        aria-controls={isOpen ? menuId : undefined}
        onClick={() => {
          if (isOpen) { beginClose(false); } else { setIsOpen(true); }
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            openedByArrowKeyRef.current = true;
            setIsOpen(true);
          }
        }}
      >
        {triggerContent}
        {TriggerIcon && <TriggerIcon className="h-4 w-4" />}
        {/* An empty label means an icon-only trigger (a row's "⋯"). There the
            chevron is redundant — it would sit beside the icon as a second
            affordance for the same click — and the accessible name comes from
            `ariaLabel`, so nothing is lost by dropping both. */}
        {!triggerContent && label !== '' && (
          <>
            <span>{label}</span>
            <ChevronDown className={cn('h-4 w-4 transition-transform', isOpen && !isClosing && 'rotate-180')} />
          </>
        )}
      </Button>

      {isOpen && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === 'Tab') { beginClose(false); return; }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])'));
            const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
            // With no item focused (menu opened by pointer), ArrowDown enters at
            // the first item and ArrowUp at the last, matching Home/End.
            const next = event.key === 'Home' || (current === -1 && event.key === 'ArrowDown') ? 0
              : event.key === 'End' || (current === -1 && event.key === 'ArrowUp') ? buttons.length - 1
              : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next]?.focus();
          }}
          className={cn(
            'absolute z-50 min-w-[220px] overflow-hidden rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl',
            side === 'top' ? 'bottom-full mb-2 w-full origin-bottom' : 'top-full mt-2 origin-top',
            // RTL-safe positioning via logical inset properties.
            align === 'end' ? 'end-0' : 'start-0',
            // Enter/exit animation — keyframes defined in tailwind.config.js.
            // prefers-reduced-motion is handled globally (index.css line 367)
            // which collapses all animation durations to 0.01ms automatically.
            isClosing ? 'animate-menu-exit' : 'animate-menu-enter',
          )}
        >
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <React.Fragment key={item.key}>
                {item.showDividerBefore && <div className="mx-2 my-1 h-px bg-border/80" />}
                <button
                  type="button"
                  role="menuitem"
                  disabled={item.disabled || item.loading}
                  onClick={() => runItem(item)}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                    // RTL-safe text alignment
                    'text-start text-popover-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                    item.disabled || item.loading
                      ? 'cursor-not-allowed opacity-50'
                      : item.isDanger
                        ? 'text-danger hover:bg-destructive/10 focus:bg-destructive/10 focus:text-danger'
                        : 'hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground',
                  )}
                >
                  {item.loading ? (
                    <Loader2 className="mt-0.5 h-4 w-4 flex-shrink-0 animate-spin" />
                  ) : (
                    Icon && <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium leading-5">{item.label}</span>
                    {item.description && (
                      <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                        {item.description}
                      </span>
                    )}
                  </span>
                </button>
              </React.Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
