import { Plus, TerminalSquare, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { ScrollArea } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import { useNowTick } from '../../../terminals/hooks/useNowTick';
import TerminalUptime from '../../../terminals/view/subcomponents/TerminalUptime';
import type { SidebarTerminalsProps } from '../../types/types';

type SidebarTerminalsSectionProps = {
  terminals: SidebarTerminalsProps;
  /** Shared sidebar namespace translator (kept for parity with siblings). */
  t: TFunction;
};

/**
 * Sidebar Terminals section (T-940): the list of standalone terminals plus a
 * "New terminal" action. Selection/creation/deletion are delegated to the
 * shared controller via `terminals` props. RTL by inheritance; spacing uses
 * logical utilities.
 */
export default function SidebarTerminalsSection({ terminals }: SidebarTerminalsSectionProps) {
  const { t } = useTranslation('terminals');
  const { items, isLoading, error, selectedTerminalId, createError, onSelect, onCreate, onDelete, onDismissCreateError } =
    terminals;

  // A single 1s timer for the whole list, and only while something runs.
  const now = useNowTick(items.some((item) => item.status === 'running'));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-shrink-0 px-2 pb-2 pt-1">
        <button
          type="button"
          onClick={onCreate}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border/70 bg-muted/30 px-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-border hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('newTerminal')}
        </button>

        {createError && (
          <div
            role="alert"
            className="mt-2 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300"
          >
            <span className="min-w-0 flex-1 leading-relaxed">{createError.message}</span>
            <button
              type="button"
              onClick={onDismissCreateError}
              aria-label={t('panel.cancel')}
              className="flex-shrink-0 rounded p-0.5 hover:bg-red-100 dark:hover:bg-red-900/40"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
        {isLoading && items.length === 0 ? (
          <div className="px-2 py-8 text-center text-sm text-muted-foreground">{t('list.loading')}</div>
        ) : error && items.length === 0 ? (
          <div className="px-2 py-8 text-center text-sm text-muted-foreground">{error}</div>
        ) : items.length === 0 ? (
          <div className="px-3 py-10 text-center">
            <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-muted">
              <TerminalSquare className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            </div>
            <p className="mb-1 text-sm font-medium text-foreground">{t('list.empty')}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{t('list.emptyHint')}</p>
          </div>
        ) : (
          <ul className="space-y-0.5">
            {items.map((item) => {
              const isSelected = item.id === selectedTerminalId;
              const isExited = item.status === 'exited';
              return (
                <li key={item.id}>
                  <div
                    className={cn(
                      'group flex items-center gap-2 rounded-lg px-2 py-2 transition-colors',
                      isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(item.id)}
                      aria-current={isSelected ? 'true' : undefined}
                      className="flex min-w-0 flex-1 items-center gap-2 text-start focus-visible:outline-none"
                    >
                      <span
                        className={cn(
                          'inline-block h-2 w-2 flex-shrink-0 rounded-full',
                          isExited ? 'bg-muted-foreground/50' : 'bg-emerald-500',
                        )}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-foreground" dir="auto">
                          {item.title}
                        </span>
                        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <span>{isExited ? t('list.exited') : t('list.running')}</span>
                          <TerminalUptime terminal={item} now={now} className="text-[10px]" />
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(item.id)}
                      aria-label={t('panel.delete')}
                      title={t('panel.deleteHint')}
                      className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-red-50 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100 dark:hover:bg-red-900/20 dark:hover:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}
