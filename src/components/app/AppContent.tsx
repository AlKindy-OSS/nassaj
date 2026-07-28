import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import Sidebar from '../sidebar/view/Sidebar';
import MainContent from '../main-content/view/MainContent';
import CommandPalette from '../command-palette/CommandPalette';
import { useTerminalsController } from '../terminals/hooks/useTerminalsController';
import TerminalDeleteConfirmModal from '../terminals/view/subcomponents/TerminalDeleteConfirmModal';
import { readSidebarSection } from '../sidebar/utils/utils';
import type { SidebarSection, SidebarTerminalsProps } from '../sidebar/types/types';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { PaletteOpsProvider, usePaletteOpsRegister } from '../../contexts/PaletteOpsContext';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { useSessionProtection } from '../../hooks/useSessionProtection';
import { useProjectsState } from '../../hooks/useProjectsState';
import {
  reconcilePresenceProcessStates,
  setSessionProcessState,
} from '../../stores/sessionProcessStateStore';
import {
  PRESENCE_MESSAGE_TYPE,
  parseRunningSessions,
} from '../presence/usePresence';
import {
  clearSessionFinishedUnopened,
  markSessionFinishedUnopened,
  shouldMarkSessionFinished,
} from '../../stores/sessionCompletionStore';
import { useActiveWorkflows } from '../../stores/useActiveWorkflows';

import BuildUpdateBanner from './BuildUpdateBanner';

export default function AppContent() {
  return (
    <PaletteOpsProvider>
      <AppContentInner />
    </PaletteOpsProvider>
  );
}

function AppContentInner() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const { t } = useTranslation('common');
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { ws, sendMessage, latestMessage, isConnected } = useWebSocket();
  const wasConnectedRef = useRef(false);

  const {
    activeSessions,
    processingSessions,
    markSessionAsActive,
    markSessionAsInactive,
    markSessionAsProcessing,
    markSessionAsNotProcessing,
  } = useSessionProtection();

  const {
    selectedProject,
    selectedSession,
    activeTab,
    sidebarOpen,
    isLoadingProjects,
    externalMessageUpdate,
    newSessionTrigger,
    setActiveTab,
    setSidebarOpen,
    setIsInputFocused,
    setShowSettings,
    openSettings,
    refreshProjectsSilently,
    sidebarSharedProps,
    handleNewSession,
  } = useProjectsState({
    sessionId,
    navigate,
    latestMessage,
    isMobile,
    activeSessions,
  });

  // Standalone terminals (T-939): one shared controller high in the tree feeds
  // both the sidebar's Terminals section and the full-area terminals panel.
  const [selectedTerminalId, setSelectedTerminalId] = useState<string | null>(null);
  const terminalsController = useTerminalsController();
  const {
    terminals: terminalItems,
    refresh: refreshTerminals,
    createTerminal,
    renameTerminal,
    deleteTerminal,
  } = terminalsController;

  // Bridge the sidebar's section toggle to the main-content surface: entering
  // Terminals shows the panel; leaving it returns to chat (never leaving the
  // surface stuck on 'terminal').
  const handleSidebarSectionChange = useCallback(
    (section: SidebarSection) => {
      if (section === 'terminals') {
        setActiveTab('terminal');
      } else {
        setActiveTab((previous) => (previous === 'terminal' ? 'chat' : previous));
      }
    },
    [setActiveTab],
  );

  const handleSelectTerminal = useCallback(
    (id: string) => {
      setSelectedTerminalId(id);
      setActiveTab('terminal');
      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [isMobile, setActiveTab, setSidebarOpen],
  );

  const handleCreateTerminal = useCallback(async () => {
    const created = await createTerminal();
    if (created) {
      setSelectedTerminalId(created.id);
      setActiveTab('terminal');
      if (isMobile) {
        setSidebarOpen(false);
      }
    }
  }, [createTerminal, isMobile, setActiveTab, setSidebarOpen]);

  const [terminalPendingDeleteId, setTerminalPendingDeleteId] = useState<string | null>(null);

  const performDeleteTerminal = useCallback(
    async (id: string) => {
      await deleteTerminal(id);
      setSelectedTerminalId((current) => (current === id ? null : current));
    },
    [deleteTerminal],
  );

  // Confirm before killing a RUNNING terminal (kills the PTY and drops its
  // buffer); an already-exited terminal is removed immediately.
  const handleDeleteTerminal = useCallback(
    (id: string) => {
      const target = terminalItems.find((item) => item.id === id);
      if (target && target.status === 'running') {
        setTerminalPendingDeleteId(id);
        return;
      }
      void performDeleteTerminal(id);
    },
    [performDeleteTerminal, terminalItems],
  );

  const confirmDeleteTerminal = useCallback(() => {
    if (terminalPendingDeleteId) {
      void performDeleteTerminal(terminalPendingDeleteId);
    }
    setTerminalPendingDeleteId(null);
  }, [performDeleteTerminal, terminalPendingDeleteId]);

  const cancelDeleteTerminal = useCallback(() => {
    setTerminalPendingDeleteId(null);
  }, []);

  const handleCloseTerminal = useCallback(() => {
    setSelectedTerminalId(null);
  }, []);

  // Honor the persisted sidebar section once on mount so the surface matches the
  // sidebar (the terminal surface itself is intentionally not tab-persisted,
  // mirroring wiki/board).
  const didHonorSectionRef = useRef(false);
  useEffect(() => {
    if (didHonorSectionRef.current) {
      return;
    }
    didHonorSectionRef.current = true;
    if (readSidebarSection() === 'terminals') {
      setActiveTab('terminal');
    }
  }, [setActiveTab]);

  const sidebarTerminalsProps: SidebarTerminalsProps = useMemo(
    () => ({
      items: terminalItems,
      isLoading: terminalsController.isLoading,
      error: terminalsController.error,
      selectedTerminalId,
      createError: terminalsController.createError,
      onSelect: handleSelectTerminal,
      onCreate: handleCreateTerminal,
      onDelete: handleDeleteTerminal,
      onDismissCreateError: terminalsController.clearCreateError,
    }),
    [
      terminalItems,
      terminalsController.isLoading,
      terminalsController.error,
      terminalsController.createError,
      terminalsController.clearCreateError,
      selectedTerminalId,
      handleSelectTerminal,
      handleCreateTerminal,
      handleDeleteTerminal,
    ],
  );

  usePaletteOpsRegister({
    openSettings,
    refreshProjects: refreshProjectsSilently,
  });

  // Background-workflow surface (B-103): one driver mounted here behind the
  // auth gate; any badge subscribes to workflowStatusStore directly.
  const { scheduleRefetch: scheduleWorkflowRefetch } = useActiveWorkflows(isConnected);

  // Frozen-session indicator: route server process_state broadcasts (and
  // terminal events as an idle fallback) into the global per-session store
  // consumed by the sidebar badges, chat header, and status spinner.
  //
  // The same stream drives the "finished — not opened yet" mark: a completion
  // signal for a session the user is NOT viewing flips its dot from pulsing
  // (running) to steady (done) until the conversation is opened. The ref
  // guards against re-marking when this effect re-runs for a selection change
  // while `latestMessage` still points at an already-processed payload.
  const processedCompletionRef = useRef<unknown>(null);
  useEffect(() => {
    const msg = latestMessage;
    if (!msg || typeof msg.sessionId !== 'string' || !msg.sessionId) {
      return;
    }
    if (processedCompletionRef.current !== msg) {
      processedCompletionRef.current = msg;
      if (shouldMarkSessionFinished(msg, selectedSession?.id)) {
        markSessionFinishedUnopened(msg.sessionId);
      }
    }
    if (msg.kind === 'status' && msg.text === 'process_state' && typeof msg.processState === 'string') {
      setSessionProcessState(msg.sessionId, msg.processState);
    } else if (msg.kind === 'complete' || msg.kind === 'error') {
      setSessionProcessState(msg.sessionId, 'idle');
      // A session completing may have been a workflow step — refetch sooner.
      scheduleWorkflowRefetch();
    }
  }, [latestMessage, selectedSession?.id, scheduleWorkflowRefetch]);

  // B-269: second feed for the same store. The effect above only ever learns
  // about sessions this client mirrors (i.e. has opened), so every other running
  // conversation counted by the presence badge stayed badge-less. Presence
  // broadcasts its `runningSessions` list to every socket, already filtered to
  // what this user may see — folding it in lights the sidebar badges and project
  // busy dots for conversations that were never opened here. Mounted once,
  // unlike PresencePanel, which unmounts with the collapsed sidebar.
  useEffect(() => {
    const msg = latestMessage as { type?: string; runningSessions?: unknown } | null;
    if (!msg || msg.type !== PRESENCE_MESSAGE_TYPE) {
      return;
    }
    reconcilePresenceProcessStates(parseRunningSessions(msg.runningSessions));
  }, [latestMessage]);

  // Opening a conversation consumes its "finished — not opened yet" mark.
  useEffect(() => {
    if (selectedSession?.id) {
      clearSessionFinishedUnopened(selectedSession.id);
    }
  }, [selectedSession?.id]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return undefined;
    }

    const handleServiceWorkerMessage = (event: MessageEvent) => {
      const message = event.data;
      if (!message || message.type !== 'notification:navigate') {
        return;
      }

      if (typeof message.provider === 'string' && message.provider.trim()) {
        localStorage.setItem('selected-provider', message.provider);
      }

      setActiveTab('chat');
      setSidebarOpen(false);
      void refreshProjectsSilently();

      if (typeof message.sessionId === 'string' && message.sessionId) {
        navigate(`/session/${message.sessionId}`);
        return;
      }

      navigate('/');
    };

    navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);

    return () => {
      navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
    };
  }, [navigate, refreshProjectsSilently, setActiveTab, setSidebarOpen]);

  // Permission recovery: query pending permissions on WebSocket reconnect or session change
  useEffect(() => {
    const isReconnect = isConnected && !wasConnectedRef.current;

    if (isReconnect) {
      wasConnectedRef.current = true;
    } else if (!isConnected) {
      wasConnectedRef.current = false;
    }

    if (isConnected && selectedSession?.id) {
      sendMessage({
        type: 'get-pending-permissions',
        sessionId: selectedSession.id
      });
    }
  }, [isConnected, selectedSession?.id, sendMessage]);

  // Adjust the app container to stay above the virtual keyboard on iOS Safari.
  // On Chrome for Android the layout viewport already shrinks when the keyboard opens,
  // so inset-0 adjusts automatically. On iOS the layout viewport stays full-height and
  // the keyboard overlays it — we use the Visual Viewport API to track keyboard height
  // and apply it as a CSS variable that shifts the container's bottom edge up.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      // Only resize matters — keyboard open/close changes vv.height.
      // Do NOT listen to scroll: on iOS Safari, scrolling content changes
      // vv.offsetTop which would make --keyboard-height fluctuate during
      // normal scrolling, causing the container to bounce up and down.
      const kb = Math.max(0, window.innerHeight - vv.height);
      document.documentElement.style.setProperty('--keyboard-height', `${kb}px`);
    };
    vv.addEventListener('resize', update);
    return () => vv.removeEventListener('resize', update);
  }, []);

  return (
    <div className="fixed inset-0 flex bg-background" style={{ bottom: 'var(--keyboard-height, 0px)' }}>
      <BuildUpdateBanner />
      {!isMobile ? (
        <div className="h-full flex-shrink-0 border-e border-border/50">
          <Sidebar
            {...sidebarSharedProps}
            terminals={sidebarTerminalsProps}
            onSectionChange={handleSidebarSectionChange}
          />
        </div>
      ) : (
        <div
          className={`fixed inset-0 z-50 flex transition-all duration-150 ease-out ${sidebarOpen ? 'visible opacity-100' : 'invisible opacity-0'
            }`}
        >
          <button
            className="fixed inset-0 bg-background/60 backdrop-blur-sm transition-opacity duration-150 ease-out"
            onClick={(event) => {
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            onTouchStart={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            aria-label={t('versionUpdate.ariaLabels.closeSidebar')}
          />
          <div
            className={`relative h-full w-[85vw] max-w-sm transform border-e border-border/40 bg-card transition-transform duration-150 ease-out sm:w-80 ${sidebarOpen ? 'translate-x-0' : 'ltr:-translate-x-full rtl:translate-x-full'
              }`}
            onClick={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
          >
            <Sidebar
              {...sidebarSharedProps}
              terminals={sidebarTerminalsProps}
              onSectionChange={handleSidebarSectionChange}
            />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <MainContent
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          ws={ws}
          sendMessage={sendMessage}
          latestMessage={latestMessage}
          isMobile={isMobile}
          onMenuClick={() => setSidebarOpen(true)}
          isLoading={isLoadingProjects}
          onInputFocusChange={setIsInputFocused}
          onSessionActive={markSessionAsActive}
          onSessionInactive={markSessionAsInactive}
          onSessionProcessing={markSessionAsProcessing}
          onSessionNotProcessing={markSessionAsNotProcessing}
          processingSessions={processingSessions}
          onNavigateToSession={(targetSessionId: string, options) =>
            navigate(`/session/${targetSessionId}`, { replace: Boolean(options?.replace) })
          }
          onShowSettings={(dest) => {
            if (dest) {
              openSettings(dest.tab ?? 'agents', dest);
            } else {
              setShowSettings(true);
            }
          }}
          externalMessageUpdate={externalMessageUpdate}
          newSessionTrigger={newSessionTrigger}
          terminals={terminalItems}
          selectedTerminalId={selectedTerminalId}
          onRenameTerminal={renameTerminal}
          onDeleteTerminal={handleDeleteTerminal}
          onCloseTerminal={handleCloseTerminal}
          onRefreshTerminals={refreshTerminals}
        />
      </div>

      <CommandPalette
        selectedProject={selectedProject}
        onStartNewChat={handleNewSession}
        onOpenSettings={() => openSettings()}
        onShowTab={setActiveTab}
      />

      <TerminalDeleteConfirmModal
        terminal={terminalItems.find((item) => item.id === terminalPendingDeleteId) ?? null}
        onConfirm={confirmDeleteTerminal}
        onCancel={cancelDeleteTerminal}
      />
    </div>
  );
}
