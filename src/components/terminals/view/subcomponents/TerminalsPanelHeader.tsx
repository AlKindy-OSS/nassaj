import { useEffect, useRef, useState } from 'react';
import { Check, Pencil, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tooltip } from '../../../../shared/view/ui';
import MobileMenuButton from '../../../main-content/view/subcomponents/MobileMenuButton';
import { useNowTick } from '../../hooks/useNowTick';
import type { TerminalSummary } from '../../types/types';
import TerminalUptime from './TerminalUptime';

type TerminalsPanelHeaderProps = {
  terminal: TerminalSummary | null;
  isMobile: boolean;
  onMenuClick: () => void;
  onRename: (title: string) => void;
  onClose: () => void;
  onDelete: () => void;
};

export default function TerminalsPanelHeader({
  terminal,
  isMobile,
  onMenuClick,
  onRename,
  onClose,
  onDelete,
}: TerminalsPanelHeaderProps) {
  const { t } = useTranslation('terminals');
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // Ticks only while the displayed terminal is running; an exited one is frozen.
  const now = useNowTick(terminal?.status === 'running');

  // Leave edit mode whenever the displayed terminal changes.
  useEffect(() => {
    setIsEditing(false);
  }, [terminal?.id]);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const startEditing = () => {
    if (!terminal) {
      return;
    }
    setDraftTitle(terminal.title);
    setIsEditing(true);
  };

  const commitEditing = () => {
    const trimmed = draftTitle.trim();
    if (terminal && trimmed && trimmed !== terminal.title) {
      onRename(trimmed);
    }
    setIsEditing(false);
  };

  const isExited = terminal?.status === 'exited';

  return (
    <div className="pwa-header-safe flex-shrink-0 border-b border-border/60 bg-background px-3 py-1.5 sm:px-4 sm:py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}

          {terminal ? (
            <>
              <span
                className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${
                  isExited ? 'bg-muted-foreground/50' : 'bg-emerald-500'
                }`}
                aria-hidden="true"
              />
              {isEditing ? (
                <input
                  ref={inputRef}
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  onBlur={commitEditing}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitEditing();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      setIsEditing(false);
                    }
                  }}
                  dir="auto"
                  aria-label={t('panel.renameLabel')}
                  placeholder={t('panel.titlePlaceholder')}
                  className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              ) : (
                <button
                  type="button"
                  onClick={startEditing}
                  title={t('panel.renameLabel')}
                  className="group flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-start hover:bg-accent/60"
                >
                  <span className="truncate text-sm font-medium text-foreground" dir="auto">
                    {terminal.title}
                  </span>
                  <Pencil className="h-3 w-3 flex-shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
                </button>
              )}
              {isExited && (
                <span className="flex-shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {t('list.exited')}
                </span>
              )}
              <TerminalUptime
                terminal={terminal}
                now={now}
                className="flex-shrink-0 rounded-md bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground"
              />
            </>
          ) : (
            <span className="truncate text-sm font-medium text-foreground">{t('title')}</span>
          )}
        </div>

        {terminal && (
          <div className="flex flex-shrink-0 items-center gap-0.5">
            {isEditing ? (
              <>
                <Tooltip content={t('panel.save')} position="bottom">
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={commitEditing}
                    aria-label={t('panel.save')}
                    className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent/80 hover:text-foreground"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
                <Tooltip content={t('panel.cancel')} position="bottom">
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setIsEditing(false)}
                    aria-label={t('panel.cancel')}
                    className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent/80 hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
              </>
            ) : (
              <>
                <Tooltip content={t('panel.closeHint')} position="bottom">
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label={t('panel.close')}
                    className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent/80 hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
                <Tooltip content={t('panel.deleteHint')} position="bottom">
                  <button
                    type="button"
                    onClick={onDelete}
                    aria-label={t('panel.delete')}
                    className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
