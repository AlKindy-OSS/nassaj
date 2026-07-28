import { usePresence } from '../../../presence/usePresence';
import { ActiveConversationsMenu } from '../../../presence/ActiveConversationsMenu';
import type { Project } from '../../../../types/app';

/**
 * Collapsed-rail indicator for active conversations count
 * (C-MU-UX-PRESENCE) + interactive open-projects popover.
 *
 * Thin wrapper around the shared {@link ActiveConversationsMenu}: it reads the
 * server-authoritative `activeConversations` breakdown from usePresence() and
 * renders the menu with `placement="inline-end"` so the popover opens toward the
 * inline-end of the narrow w-12 rail. `onExpand` is forwarded so selecting a
 * project also expands the collapsed sidebar. The same menu is used (with
 * `placement="bottom"`) by the expanded PresencePanel — keeping both surfaces in
 * sync (a single interactive popover, not a divergent read-only Tooltip).
 */

type PresenceCountCollapsedProps = {
  /** Sidebar project list — maps running-conversation project paths to names. */
  projects?: Project[];
  /** Select a project (and surface it in the main view). */
  onProjectSelect?: (project: Project) => void;
  /** Expand the collapsed sidebar so the selected project is visible. */
  onExpand?: () => void;
};

export function PresenceCountCollapsed({
  projects = [],
  onProjectSelect,
  onExpand,
}: PresenceCountCollapsedProps) {
  const { activeConversations } = usePresence();

  // Hide until the first presence snapshot arrives (mirrors the menu's own
  // guard, but lets us skip the rail divider entirely while empty).
  if (activeConversations === null) return null;

  return (
    <>
      <div className="nav-divider my-1 w-6" />
      <ActiveConversationsMenu
        activeConversations={activeConversations}
        projects={projects}
        onProjectSelect={onProjectSelect}
        onExpand={onExpand}
        placement="inline-end"
      />
    </>
  );
}
