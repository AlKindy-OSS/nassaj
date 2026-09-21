import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { CSSProperties } from 'react';
import {
  CornerDownLeft,
  Folder,
  MessageSquare,
  Sparkles,
  Star,
  Terminal,
  User,
  Zap,
  type LucideIcon,
} from 'lucide-react';

import { getDisplayNamespace } from '../../utils/commandNamespace';

type CommandMenuCommand = {
  name: string;
  description?: string;
  namespace?: string;
  path?: string;
  type?: string;
  view?: {
    canonicalName: string;
    title?: string;
    description?: string;
    aliases: string[];
    searchTerms: string[];
  };
  metadata?: { type?: string; [key: string]: unknown };
  [key: string]: unknown;
};

type CommandMenuProps = {
  commands?: CommandMenuCommand[];
  selectedIndex?: number;
  onSelect?: (command: CommandMenuCommand, index: number, isHover: boolean) => void;
  onClose: () => void;
  position?: { top: number; left: number; bottom?: number };
  isOpen?: boolean;
  frequentCommands?: CommandMenuCommand[];
  /** Disable only commands whose selection would execute immediately. */
  isCommandDisabled?: (command: CommandMenuCommand) => boolean;
  /** Override document direction detection; defaults to auto-detect from document.dir. */
  dir?: 'ltr' | 'rtl';
};

type CommandMenuRow = {
  command: CommandMenuCommand;
  commandIndex: number;
  renderKey: string;
};

const menuBaseStyle: CSSProperties = {
  maxHeight: '360px',
  overflowY: 'auto',
  borderRadius: '8px',
  boxShadow: '0 24px 60px rgba(2, 6, 23, 0.38), 0 0 0 1px rgba(148, 163, 184, 0.12)',
  zIndex: 1000,
  padding: '4px',
  transition: 'opacity 150ms ease-in-out, transform 150ms ease-in-out',
  backdropFilter: 'blur(12px)',
};

const namespaceLabels: Record<string, string> = {
  frequent: 'Frequently Used',
  builtin: 'Built-in Commands',
  skill: 'Skills',
  opencode: 'OpenCode Commands',
  project: 'Project Commands',
  user: 'User Commands',
  other: 'Other Commands',
};

const namespaceIcons: Record<string, LucideIcon> = {
  frequent: Star,
  builtin: Terminal,
  skill: Sparkles,
  opencode: Zap,
  project: Folder,
  user: User,
  other: MessageSquare,
};

const namespaceAccentClasses: Record<string, string> = {
  frequent: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-200',
  builtin: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-400/20 dark:bg-sky-400/10 dark:text-sky-200',
  skill: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-200',
  opencode: 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-400/20 dark:bg-violet-400/10 dark:text-violet-200',
  project: 'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-400/20 dark:bg-indigo-400/10 dark:text-indigo-200',
  user: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-400/20 dark:bg-rose-400/10 dark:text-rose-200',
  other: 'border-border bg-muted text-muted-foreground',
};

const MENU_EDGE_GAP = 16;
const MENU_MAX_HEIGHT = 360;

const getCommandKey = (command: CommandMenuCommand) =>
  `${command.name}::${command.namespace || command.type || 'other'}::${command.path || ''}`;

const getNamespaceIcon = (namespace: string) => namespaceIcons[namespace] || namespaceIcons.other;

const getNamespaceAccentClass = (namespace: string) =>
  namespaceAccentClasses[namespace] || namespaceAccentClasses.other;

const getMenuPosition = (
  position: { top: number; left: number; bottom?: number },
  isRTL: boolean,
): CSSProperties => {
  if (typeof window === 'undefined') {
    return { position: 'fixed', top: '16px', left: '16px' };
  }
  const anchorBottom = Math.max(MENU_EDGE_GAP, position.bottom ?? 90);
  const maxH = `min(${MENU_MAX_HEIGHT}px, calc(100vh - ${anchorBottom}px - ${MENU_EDGE_GAP}px))`;

  // Mobile: span the full width with fixed edge gaps — same for both directions.
  if (window.innerWidth < 640) {
    return {
      position: 'fixed',
      bottom: `${anchorBottom}px`,
      left: `${MENU_EDGE_GAP}px`,
      right: `${MENU_EDGE_GAP}px`,
      width: 'auto',
      maxWidth: `calc(100vw - ${MENU_EDGE_GAP * 2}px)`,
      maxHeight: `min(54vh, calc(100vh - ${anchorBottom}px - ${MENU_EDGE_GAP}px))`,
    };
  }

  const menuW = 420;

  if (isRTL) {
    // In RTL the menu's inline-start (visual right) should align with the textarea's right edge.
    // position.left is textareaRect.left (left edge in LTR viewport coords).
    // We don't have textareaRect.right, so we clamp from the right side of the screen
    // using position.left as a fallback reference (works for full-width or centred composers).
    // The result: menu starts from the end of the form and expands leftward (RTL natural flow).
    const distanceFromRight = Math.max(0, window.innerWidth - position.left - menuW);
    const clampedRight = Math.max(
      MENU_EDGE_GAP,
      Math.min(distanceFromRight, window.innerWidth - menuW - MENU_EDGE_GAP),
    );
    return {
      position: 'fixed',
      bottom: `${anchorBottom}px`,
      right: `${clampedRight}px`,
      width: `min(${menuW}px, calc(100vw - ${MENU_EDGE_GAP * 2}px))`,
      maxWidth: `calc(100vw - ${MENU_EDGE_GAP * 2}px)`,
      maxHeight: maxH,
    };
  }

  // LTR: anchor to the left edge of the textarea.
  const clampedLeft = Math.max(
    MENU_EDGE_GAP,
    Math.min(position.left, window.innerWidth - menuW - MENU_EDGE_GAP),
  );
  return {
    position: 'fixed',
    bottom: `${anchorBottom}px`,
    left: `${clampedLeft}px`,
    width: `min(${menuW}px, calc(100vw - ${MENU_EDGE_GAP * 2}px))`,
    maxWidth: `calc(100vw - ${MENU_EDGE_GAP * 2}px)`,
    maxHeight: maxH,
  };
};

export default function CommandMenu({
  commands = [],
  selectedIndex = -1,
  onSelect,
  onClose,
  position = { top: 0, left: 0 },
  isOpen = false,
  frequentCommands = [],
  isCommandDisabled = () => false,
  dir,
}: CommandMenuProps) {
  const { t } = useTranslation('chat');
  const menuRef = useRef<HTMLDivElement | null>(null);
  const selectedItemRef = useRef<HTMLDivElement | null>(null);

  // Detect RTL from prop override, then nearest [dir] ancestor, then document.
  const isRTL =
    dir !== undefined
      ? dir === 'rtl'
      : typeof document !== 'undefined'
        ? document.documentElement.dir === 'rtl' ||
          document.documentElement.getAttribute('dir') === 'rtl' ||
          document.body.dir === 'rtl'
        : false;

  const menuPosition = getMenuPosition(position, isRTL);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handleClickOutside = (event: MouseEvent) => {
      if (!menuRef.current || !(event.target instanceof Node)) {
        return;
      }
      if (!menuRef.current.contains(event.target)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!selectedItemRef.current || !menuRef.current) {
      return;
    }
    const menuRect = menuRef.current.getBoundingClientRect();
    const itemRect = selectedItemRef.current.getBoundingClientRect();
    if (itemRect.bottom > menuRect.bottom || itemRect.top < menuRect.top) {
      selectedItemRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex]);

  if (!isOpen) {
    return null;
  }

  const hasFrequentCommands = frequentCommands.length > 0;
  const frequentCommandKeys = new Set(frequentCommands.map(getCommandKey));
  const commandIndexesByKey = new Map<string, number[]>();
  commands.forEach((command, index) => {
    const key = getCommandKey(command);
    const commandIndexes = commandIndexesByKey.get(key) ?? [];
    commandIndexes.push(index);
    commandIndexesByKey.set(key, commandIndexes);
  });
  const frequentCommandOccurrences = new Map<string, number>();
  const getFrequentCommandIndex = (command: CommandMenuCommand): number => {
    const key = getCommandKey(command);
    const occurrence = frequentCommandOccurrences.get(key) ?? 0;
    frequentCommandOccurrences.set(key, occurrence + 1);

    const commandIndexes = commandIndexesByKey.get(key) ?? [];
    return commandIndexes[occurrence] ?? commandIndexes[0] ?? -1;
  };

  const groupedCommands = commands.reduce<Record<string, CommandMenuRow[]>>((groups, command, index) => {
    if (hasFrequentCommands && frequentCommandKeys.has(getCommandKey(command))) {
      return groups;
    }
    const namespace = getDisplayNamespace(command);
    if (!groups[namespace]) {
      groups[namespace] = [];
    }
    groups[namespace].push({
      command,
      commandIndex: index,
      renderKey: `${namespace}-${index}-${getCommandKey(command)}`,
    });
    return groups;
  }, {});
  if (hasFrequentCommands) {
    groupedCommands.frequent = frequentCommands
      .map((command, index) => {
        const commandIndex = getFrequentCommandIndex(command);
        return {
          command,
          commandIndex,
          renderKey: `frequent-${index}-${commandIndex}-${getCommandKey(command)}`,
        };
      })
      .filter((row) => row.commandIndex >= 0);
  }

  const preferredOrder = hasFrequentCommands
    ? ['frequent', 'builtin', 'skill', 'opencode', 'project', 'user', 'other']
    : ['builtin', 'skill', 'opencode', 'project', 'user', 'other'];
  const extraNamespaces = Object.keys(groupedCommands).filter((namespace) => !preferredOrder.includes(namespace));
  const orderedNamespaces = [...preferredOrder, ...extraNamespaces].filter((namespace) => groupedCommands[namespace]);

  if (commands.length === 0) {
    return (
      <div
        ref={menuRef}
        dir={isRTL ? 'rtl' : 'ltr'}
        className="command-menu command-menu-empty border border-border bg-card/95 text-sm text-muted-foreground"
        style={{
          ...menuBaseStyle,
          ...menuPosition,
          overflowY: 'hidden',
          padding: '20px',
          opacity: 1,
          transform: 'translateY(0)',
          textAlign: 'center',
        }}
      >
        {t('commandMenu.none')}
      </div>
    );
  }

  return (
    <div
      ref={menuRef}
      role="listbox"
      aria-label={t('commandMenu.ariaLabel')}
      dir={isRTL ? 'rtl' : 'ltr'}
      className="command-menu border border-border/90 bg-card/95 text-foreground"
      style={{ ...menuBaseStyle, ...menuPosition, opacity: 1, transform: 'translateY(0)' }}
    >
      {orderedNamespaces.map((namespace) => (
        <div key={namespace} className="command-group">
          {orderedNamespaces.length > 1 && (
            <div className="flex h-7 items-center justify-between px-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <span>{t(`commandMenu.groups.${namespace}`, { defaultValue: namespaceLabels[namespace] || namespace })}</span>
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-border bg-muted px-1 text-[9px] leading-none text-muted-foreground">
                {(groupedCommands[namespace] || []).length}
              </span>
            </div>
          )}

          {(groupedCommands[namespace] || []).map(({ command, commandIndex, renderKey }) => {
            const isSelected = commandIndex === selectedIndex;
            const isDisabled = isCommandDisabled(command);
            const NamespaceIcon = getNamespaceIcon(namespace);
            const accentClass = getNamespaceAccentClass(namespace);
            return (
              <div
                key={renderKey}
                ref={isSelected ? selectedItemRef : null}
                role="option"
                aria-selected={isSelected}
                aria-disabled={isDisabled || undefined}
                className={`command-item group relative flex min-h-11 items-center gap-2 rounded-md border px-2 py-1 transition-all ${
                  isDisabled
                    ? 'cursor-not-allowed border-transparent bg-transparent opacity-50'
                    : isSelected
                    ? 'border-sky-200 bg-sky-50 shadow-sm dark:border-cyan-400/30 dark:bg-cyan-400/10'
                    : 'cursor-pointer border-transparent bg-transparent hover:border-border hover:bg-accent/90'
                }`}
                onMouseEnter={isDisabled
                  ? undefined
                  : () => onSelect && commandIndex >= 0 && onSelect(command, commandIndex, true)}
                onClick={isDisabled
                  ? undefined
                  : () => onSelect && commandIndex >= 0 && onSelect(command, commandIndex, false)}
                onMouseDown={(event) => event.preventDefault()}
              >
                {isSelected && !isDisabled && (
                  <span className="absolute bottom-1.5 start-1 top-1.5 w-0.5 rounded-full bg-sky-500 dark:bg-cyan-300" />
                )}
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded border ${accentClass}`}>
                  <NamespaceIcon aria-hidden="true" size={13} strokeWidth={2.2} />
                </span>
                <div className="min-w-0 flex-1 pe-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    {command.view?.title ? (
                      <span className="min-w-0 truncate text-[13px] font-semibold leading-4 text-foreground">
                        {command.view.title}{' '}<span aria-hidden="true">(</span><bdi dir="ltr" className="text-left font-mono" title={command.name}>{command.view.canonicalName}</bdi><span aria-hidden="true">)</span>
                      </span>
                    ) : (
                      <bdi
                        dir="ltr"
                        className="shrink-0 text-left font-mono text-[13px] font-semibold leading-4 text-foreground"
                        title={command.name}
                      >
                        {command.name}
                      </bdi>
                    )}
                    {command.metadata?.type && (
                      <span className="command-metadata-badge inline-flex h-4 shrink-0 items-center rounded border border-border bg-card px-1 text-[9px] font-medium leading-none text-muted-foreground">
                        {command.metadata.type}
                      </span>
                    )}
                  </div>
                  {(command.view?.description || command.description) && (
                    <div
                      className="truncate whitespace-nowrap text-[11px] leading-4 text-muted-foreground"
                      title={command.view?.description || command.description}
                    >
                      {command.view?.description || command.description}
                    </div>
                  )}
                  {command.type === 'skill' && command.metadata?.disableModelInvocation === true && <p className="text-xs text-foreground">{t('skillObservations.manualOnly')}</p>}
                </div>
                {isSelected && !isDisabled && (
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-sky-200 bg-card text-sky-600 dark:border-cyan-400/30 dark:text-cyan-200">
                    <CornerDownLeft aria-hidden="true" size={11} strokeWidth={2.2} />
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
