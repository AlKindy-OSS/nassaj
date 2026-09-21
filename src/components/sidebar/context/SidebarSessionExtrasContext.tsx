import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

/**
 * Row-level extras for sidebar session items (B-332).
 *
 * Most of it is consumed by SidebarSessionItem, four levels below the
 * controller (Sidebar → SidebarContent → SidebarProjectList → SidebarProjectItem
 * → SidebarProjectSessions → SidebarSessionItem). Threading two more props
 * through five components would add churn to every layer in between for data
 * only the leaf reads — hence a context.
 *
 * The default value is inert (no snippets, no-op archive) so components mounted
 * outside the provider — unit tests, in particular — render unchanged.
 */
export type SidebarSessionExtras = {
  /** sessionId → matching message snippet, while a message search is active. */
  messageSnippets: Map<string, string>;
  /** Soft-delete (archive) one session directly from its row. */
  onArchiveSession: (sessionId: string) => void;
  /**
   * True while the sidebar is hiding closed conversations. Read by
   * SidebarProjectSessions, not by the row: a project whose sessions are ALL
   * closed empties out under the filter, and the standing "no conversations"
   * line would then be a lie the user cannot see through — the conversations
   * exist, the filter is holding them.
   */
  hideClosedSessions: boolean;
};

const EMPTY_EXTRAS: SidebarSessionExtras = {
  messageSnippets: new Map(),
  onArchiveSession: () => {},
  hideClosedSessions: false,
};

const SidebarSessionExtrasContext = createContext<SidebarSessionExtras>(EMPTY_EXTRAS);

export function SidebarSessionExtrasProvider({
  value,
  children,
}: {
  value: SidebarSessionExtras;
  children: ReactNode;
}) {
  return (
    <SidebarSessionExtrasContext.Provider value={value}>
      {children}
    </SidebarSessionExtrasContext.Provider>
  );
}

export function useSidebarSessionExtras(): SidebarSessionExtras {
  return useContext(SidebarSessionExtrasContext);
}
