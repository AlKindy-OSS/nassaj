/**
 * useWikiKeyboard.ts — Keyboard shortcuts for the wiki viewer.
 *
 * Shortcuts:
 *  - Escape: close drawer (if open, no query) or clear query.
 *  - Ctrl+K / Cmd+K: open sidebar and focus search.
 *  - /: focus search (when not already in an input).
 */

import { useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

type Options = {
  query: string;
  clearQuery: () => void;
  sidebarOpen: boolean;
  setSidebarOpen: (updater: (prev: boolean) => boolean) => void;
  setCloseAnnouncement: (msg: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement>;
  sidebarToggleRef: React.RefObject<HTMLButtonElement | null>;
};

export function useWikiKeyboard({
  query,
  clearQuery,
  setSidebarOpen,
  setCloseAnnouncement,
  searchInputRef,
  sidebarToggleRef,
}: Options): void {
  const { t } = useTranslation();

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable;

      if (e.key === 'Escape') {
        if (query.trim()) {
          clearQuery();
        } else {
          // A11y (WCAG SC 2.1.1, 3.2.2): when the drawer is open and Escape
          // collapses it, return focus to the toggle button and announce the
          // change so screen-reader users aren't left on a hidden region.
          setSidebarOpen((open) => {
            if (open) {
              setCloseAnnouncement(t('wiki.indexClosed', 'تم إغلاق الفهرس'));
              requestAnimationFrame(() => sidebarToggleRef.current?.focus());
            }
            return false;
          });
        }
        return;
      }

      // Ctrl+K / Cmd+K — focus search
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setSidebarOpen(() => true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
        return;
      }

      // "/" — focus search (only when not already in an input)
      if (e.key === '/' && !inInput) {
        e.preventDefault();
        setSidebarOpen(() => true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
    },
    [query, clearQuery, t, setSidebarOpen, setCloseAnnouncement, searchInputRef, sidebarToggleRef],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
