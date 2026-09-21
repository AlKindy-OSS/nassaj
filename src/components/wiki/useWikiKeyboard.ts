/**
 * useWikiKeyboard.ts — global keyboard shortcuts for the wiki viewer.
 *
 * Shortcuts:
 *  - Ctrl+K / Cmd+K : open the search dialog.
 *  - "/"            : open the search dialog (when not typing in a field).
 *  - Escape         : close the index drawer.
 *
 * Escape *inside* the search dialog is handled by the dialog itself; this hook
 * bails while it is open so one key press does not both close the dialog and
 * collapse the drawer behind it.
 */

import { useEffect, useCallback } from 'react';

type Options = {
  searchOpen: boolean;
  openSearch: () => void;
  setSidebarOpen: (updater: (prev: boolean) => boolean) => void;
  setCloseAnnouncement: (msg: string) => void;
  sidebarToggleRef: React.RefObject<HTMLButtonElement | null>;
  /** Live-region text announced when Escape collapses the index. */
  closedMessage: string;
};

export function useWikiKeyboard({
  searchOpen,
  openSearch,
  setSidebarOpen,
  setCloseAnnouncement,
  sidebarToggleRef,
  closedMessage,
}: Options): void {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable;

      // Ctrl+K / Cmd+K — open search. Works even from inside a field.
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        openSearch();
        return;
      }

      // The dialog owns every other key while it is open.
      if (searchOpen) return;

      if (e.key === 'Escape') {
        // A11y (WCAG SC 2.1.1, 3.2.2): when the drawer is open and Escape
        // collapses it, return focus to the toggle button and announce the
        // change so screen-reader users aren't left on a hidden region.
        setSidebarOpen((open) => {
          if (open) {
            setCloseAnnouncement(closedMessage);
            requestAnimationFrame(() => sidebarToggleRef.current?.focus());
          }
          return false;
        });
        return;
      }

      // "/" — open search (only when not already typing somewhere)
      if (e.key === '/' && !inInput) {
        e.preventDefault();
        openSearch();
      }
    },
    [searchOpen, openSearch, setSidebarOpen, setCloseAnnouncement, sidebarToggleRef, closedMessage],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
