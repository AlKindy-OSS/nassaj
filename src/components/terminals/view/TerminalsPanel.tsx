import { useMemo } from 'react';

import type { TerminalSummary } from '../types/types';

import TerminalsPanelHeader from './subcomponents/TerminalsPanelHeader';
import TerminalsEmptyState from './subcomponents/TerminalsEmptyState';
import TerminalView from './subcomponents/TerminalView';

export type TerminalsPanelProps = {
  terminals: TerminalSummary[];
  selectedTerminalId: string | null;
  isMobile: boolean;
  onMenuClick: () => void;
  onRenameTerminal: (id: string, title: string) => void;
  onDeleteTerminal: (id: string) => void;
  /** Deselect (detach the view) — the server keeps the PTY running. */
  onCloseTerminal: () => void;
  onRequestListRefresh: () => void;
};

/**
 * Full-area standalone-terminals panel (T-939), rendered by MainContent when
 * `activeTab === 'terminal'` — independent of any selected project. The sidebar
 * owns the list + creation; this panel shows exactly one terminal at a time.
 */
export default function TerminalsPanel({
  terminals,
  selectedTerminalId,
  isMobile,
  onMenuClick,
  onRenameTerminal,
  onDeleteTerminal,
  onCloseTerminal,
  onRequestListRefresh,
}: TerminalsPanelProps) {
  const selectedTerminal = useMemo(
    () => terminals.find((item) => item.id === selectedTerminalId) ?? null,
    [terminals, selectedTerminalId],
  );

  return (
    <div className="flex h-full flex-col">
      <TerminalsPanelHeader
        terminal={selectedTerminal}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        onRename={(title) => {
          if (selectedTerminal) {
            onRenameTerminal(selectedTerminal.id, title);
          }
        }}
        onClose={onCloseTerminal}
        onDelete={() => {
          if (selectedTerminal) {
            onDeleteTerminal(selectedTerminal.id);
          }
        }}
      />

      <div className="min-h-0 flex-1 overflow-hidden">
        {selectedTerminal ? (
          <TerminalView
            key={selectedTerminal.id}
            terminal={selectedTerminal}
            isActive
            onRequestListRefresh={onRequestListRefresh}
          />
        ) : (
          <TerminalsEmptyState />
        )}
      </div>
    </div>
  );
}
