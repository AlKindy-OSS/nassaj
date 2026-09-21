import { useEffect, useRef, useState } from 'react';
import { Check, Heading, MessagesSquare, SearchCheck, type LucideIcon } from 'lucide-react';
import type { TFunction } from 'i18next';

import { cn } from '../../../../lib/utils';
import type { SidebarSearchScope } from '../../types/types';

type SidebarSearchScopeMenuProps = {
  scope: SidebarSearchScope;
  onScopeChange: (scope: SidebarSearchScope) => void;
  /** Square size of the trigger — matches the adjacent search input height. */
  sizeClass: string;
  t: TFunction;
};

const SCOPE_ICON: Record<SidebarSearchScope, LucideIcon> = {
  all: SearchCheck,
  titles: Heading,
  messages: MessagesSquare,
};

/**
 * Search-scope picker (B-332): titles, conversations, or both.
 *
 * A popover rather than a cycling button, because the three states are not
 * ordered and a cycling control would never say what it is about to become.
 * Positioned with logical inset (`end-0`) so it opens on the correct side in
 * both directions.
 */
export default function SidebarSearchScopeMenu({
  scope,
  onScopeChange,
  sizeClass,
  t,
}: SidebarSearchScopeMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const options: { value: SidebarSearchScope; label: string; hint: string }[] = [
    {
      value: 'all',
      label: t('search.scopeAll', 'Titles + conversations'),
      hint: t('search.scopeAllHint', 'Titles filter instantly; message matches join in as they are found'),
    },
    {
      value: 'titles',
      label: t('search.scopeTitles', 'Titles only'),
      hint: t('search.scopeTitlesHint', 'Project names, paths and session titles'),
    },
    {
      value: 'messages',
      label: t('search.scopeMessages', 'Conversations only'),
      hint: t('search.scopeMessagesHint', 'Message bodies inside conversations'),
    },
  ];

  const activeOption = options.find((option) => option.value === scope) ?? options[0];
  const TriggerIcon = SCOPE_ICON[scope];
  const label = t('search.scopeTooltip', 'Search scope: {{scope}}', { scope: activeOption.label });

  return (
    <div ref={containerRef} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setIsOpen((previous) => !previous)}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={label}
        title={label}
        className={cn(
          'flex flex-shrink-0 items-center justify-center rounded-xl border border-transparent text-xs font-medium transition-all',
          sizeClass,
          isOpen || scope !== 'all'
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
        )}
      >
        <TriggerIcon className="h-3.5 w-3.5" />
      </button>

      {isOpen && (
        <div
          role="menu"
          aria-label={t('search.scopeMenuLabel', 'Search scope')}
          className="absolute end-0 top-full z-50 mt-1 min-w-[220px] origin-top animate-menu-enter rounded-lg border border-border bg-popover p-1 shadow-lg"
        >
          {options.map((option) => {
            const isActive = option.value === scope;
            const OptionIcon = SCOPE_ICON[option.value];

            return (
              <button
                key={option.value}
                role="menuitemradio"
                aria-checked={isActive}
                type="button"
                onClick={() => {
                  onScopeChange(option.value);
                  setIsOpen(false);
                }}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-start transition-colors hover:bg-accent focus:bg-accent focus:outline-none"
              >
                <OptionIcon className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium text-foreground">{option.label}</span>
                  <span className="block text-[11px] leading-snug text-muted-foreground">{option.hint}</span>
                </span>
                {isActive && <Check className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-foreground" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
