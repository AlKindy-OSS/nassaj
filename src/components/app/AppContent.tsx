import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { Project } from '../../types/app';
import Sidebar from '../sidebar/view/Sidebar';
import Settings from '../settings/view/Settings';
import { normalizeProjectForSettings } from '../sidebar/utils/utils';
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
  applyOutcomeDelta,
  useTopOutcome,
} from '../../stores/sessionCompletionStore';
import { setTitleOutcome } from '../../utils/pageTitleNotification';
import { loadConnectors } from '../../stores/connectorsStore';
import { useActiveWorkflows } from '../../stores/useActiveWorkflows';
import { useAuth } from '../auth';
import { useScheduledMessagesSummary } from '../scheduled-messages/hooks/useScheduledMessagesSummary';
import { isScheduledMessagesCenterEnabled } from '../scheduled-messages/scheduledMessagesFeature';
import ScheduledMessagesCenterRoute from '../scheduled-messages/view/ScheduledMessagesCenterRoute';

import BuildUpdateBanner from './BuildUpdateBanner';
import { useSessionOutcomeAcknowledgement } from './hooks/useSessionOutcomeAcknowledgement';
import { getShellVisualViewportGeometry } from './visualViewportGeometry';
import {
  clearProjectToolDestination,
  navigateToProjectTool,
  readProjectToolDestination,
  resolveProjectToolDestination,
  shouldClearProjectToolDestination,
  type ProjectTool,
} from './projectToolUrl';

export default function AppContent() {
  return (
    <PaletteOpsProvider>
      <AppContentInner />
    </PaletteOpsProvider>
  );
}

function AppContentInner() {
  const navigate = useNavigate();
  const location = useLocation();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const { t } = useTranslation('common');
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { user } = useAuth();
  const scheduledCenterEnabled = isScheduledMessagesCenterEnabled(user?.role);
  const scheduledSummary = useScheduledMessagesSummary(scheduledCenterEnabled);
  const isScheduledRoute = location.pathname === '/scheduled' && scheduledCenterEnabled;
  useEffect(() => {
    if (location.pathname === '/scheduled' && !scheduledCenterEnabled) navigate('/', { replace: true });
  }, [location.pathname, navigate, scheduledCenterEnabled]);
  const {
    ws,
    sendMessage,
    latestMessage,
    controlEvents,
    isConnected,
  } = useWebSocket();
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
    openSettings,
    showSettings,
    settingsInitialTab,
    settingsDeepLink,
    closeSettings,
    refreshProjectsSilently,
    handleSelectedSessionClosedChange,
    deepLinkResolution,
    retryDeepLinkResolution,
    sidebarSharedProps,
    handleNewSession,
    selectProjectForTool,
  } = useProjectsState({
    sessionId,
    navigate,
    latestMessage,
    isMobile,
    activeSessions,
  });

  const [projectToolbarId, setProjectToolbarId] = useState<string | null>(null);
  const handledProjectToolLocationRef = useRef<string | null>(null);
  const restoringProjectToolLocationRef = useRef<string | null>(null);
  const openProjectTool = useCallback((project: Project, tool: ProjectTool) => {
    // One navigation carries the project and tool together. Selecting first
    // then rewriting the URL briefly produced a stale project-tool route.
    navigateToProjectTool(navigate, location.search, project.projectId, tool);
    if (isMobile) setSidebarOpen(false);
  }, [isMobile, location.search, navigate, setSidebarOpen]);

  // Project tools have no standalone route because they are a surface of a
  // selected project. The URL therefore carries both identifiers and resolves
  // them only after the project list exists. Invalid or unavailable IDs are
  // ignored rather than changing the current workspace selection.
  useEffect(() => {
    if (isLoadingProjects) return;
    const rawDestination = readProjectToolDestination(location.search);
    const destination = resolveProjectToolDestination(sidebarSharedProps.projects, location.search);
    if (!destination) {
      if (rawDestination) clearProjectToolDestination();
      return;
    }

    if (handledProjectToolLocationRef.current !== location.key) {
      handledProjectToolLocationRef.current = location.key;
      restoringProjectToolLocationRef.current = location.key;
      if (selectedProject?.projectId !== destination.project.projectId) {
        selectProjectForTool(destination.project);
      }
      if (activeTab !== destination.tool) setActiveTab(destination.tool);
    }

    if (
      restoringProjectToolLocationRef.current === location.key
      && selectedProject?.projectId === destination.project.projectId
      && activeTab === destination.tool
    ) {
      restoringProjectToolLocationRef.current = null;
    }
  }, [activeTab, isLoadingProjects, location.key, location.search, selectProjectForTool, selectedProject?.projectId, setActiveTab, sidebarSharedProps.projects]);

  // A tool URL is valid only while that exact project's tool is visible. Once
  // chat or another project takes over, retaining it would resurrect an old
  // project on the next reload.
  useEffect(() => {
    if (isLoadingProjects) return;
    const rawDestination = readProjectToolDestination(window.location.search);
    const destination = resolveProjectToolDestination(sidebarSharedProps.projects, window.location.search);
    if (!destination) {
      if (rawDestination) clearProjectToolDestination();
      return;
    }
    if (shouldClearProjectToolDestination(
      { projectId: destination.project.projectId, tool: destination.tool },
      selectedProject?.projectId,
      activeTab,
      restoringProjectToolLocationRef.current === location.key,
    )) clearProjectToolDestination();
  }, [activeTab, isLoadingProjects, location.key, selectedProject?.projectId, sidebarSharedProps.projects]);

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
      if (location.pathname === '/scheduled') {
        navigate('/');
      }
      if (section === 'terminals') {
        setActiveTab('terminal');
      } else {
        setActiveTab((previous) => (previous === 'terminal' ? 'chat' : previous));
      }
    },
    [location.pathname, navigate, setActiveTab],
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
  // while `latestMessage` still points at an already-processed payload. Outbox
  // delivery is intentionally not consumed here: this slot can overwrite a
  // terminal event before React observes it.
  const processedCompletionRef = useRef<unknown>(null);
  useSessionOutcomeAcknowledgement({
    routeSessionId: sessionId ?? null,
    routeLocationKey: location.key,
    selectedSessionId: selectedSession?.id ?? null,
    isConnected,
  });
  useEffect(() => {
    const msg = latestMessage;
    if (!msg || typeof msg.sessionId !== 'string' || !msg.sessionId) {
      return;
    }
    if (processedCompletionRef.current === msg) return;
    processedCompletionRef.current = msg;
    /**
     * B-577 — دلتا حالة المحادثة: الخادم يحكم، والعميل يعرض.
     *
     * الاشتقاق كان يقع هنا ويُخزَّن في `localStorage`، فمن كان مغلقاً لحظة
     * الانتهاء لا يرى شيئاً أبداً. صار الحكم يُكتب مرّةً عند مختنق الإرسال
     * الخادميّ ويُبثّ لكل من يرى المحادثة — مهما كان مَن شغّلها.
     */
    if (msg.type === 'session_outcome' && typeof msg.sessionId === 'string') {
      const outcomeState = msg.outcomeState;
      if (outcomeState !== 'visible' && outcomeState !== 'seen' && outcomeState !== 'absent') {
        return;
      }
      applyOutcomeDelta(
        msg.sessionId,
        (msg.outcome ?? null) as Parameters<typeof applyOutcomeDelta>[1],
        typeof msg.outcomeAt === 'string' ? msg.outcomeAt : null,
        outcomeState,
      );
    }

  }, [latestMessage]);

  // Terminal events also trigger an eager workflow refresh. Consume the
  // append-only control log so a following stream delta cannot suppress it.
  const processedWorkflowTerminalSeqRef = useRef(0);
  useEffect(() => {
    let shouldRefresh = false;
    for (const { seq, frame } of controlEvents.events) {
      if (seq <= processedWorkflowTerminalSeqRef.current) continue;
      if (frame?.kind === 'complete' || frame?.kind === 'error') {
        shouldRefresh = true;
      }
      processedWorkflowTerminalSeqRef.current = seq;
    }
    if (shouldRefresh) scheduleWorkflowRefetch();
  }, [controlEvents, scheduleWorkflowRefetch]);

  /**
   * B-538/B-544 — علامة العنوان تتبع الحالة لا اللحظة، وتحمل **أعلى** ما ينتظر
   * المستخدم: سؤالٌ ينتظر جوابه، ثم خطأ، ثم نهايةٌ ناجحة.
   */
  const topOutcome = useTopOutcome();
  useEffect(() => {
    setTitleOutcome(topOutcome);
  }, [topOutcome]);

  /**
   * Warm the connectors lists while the browser is idle (owner request:
   * "why isn't it part of loading the page itself, like the rest of settings").
   *
   * Idle rather than immediate, and behind a timer fallback for Safari, which
   * has no `requestIdleCallback`: three GETs worth ~13KB must never compete with
   * the first paint or the session list. By the time anyone opens Settings the
   * store is full, so the tab renders with no spinner at all — and if they open
   * it sooner, the dialog's own open-burst still covers it.
   */
  useEffect(() => {
    const idle = (window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (idle) {
      idle(() => void loadConnectors(), { timeout: 4000 });
      return undefined;
    }
    const timer = window.setTimeout(() => void loadConnectors(), 2500);
    return () => window.clearTimeout(timer);
  }, []);

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

  // Anchor the shell to the VISUAL viewport, not the layout viewport (B-510).
  //
  // The shell is `fixed inset-0`, which pins it to the LAYOUT viewport. When the
  // virtual keyboard opens, neither engine shrinks that viewport: Chromium
  // defaults to `interactive-widget=resizes-visual` (since Chrome 108 — the note
  // that used to sit here claimed the opposite, which was only true before that)
  // and iOS Safari never shrank it. Instead both SCROLL the visual viewport down
  // so the focused composer stays visible, which is what `vv.offsetTop` measures.
  // The shell does not follow: its header slides above the visible area and its
  // bottom runs under the keyboard.
  //
  // The previous code set `bottom` to `innerHeight - vv.height`. That quantity is
  // the keyboard height PLUS `vv.offsetTop`, so it cropped the bottom by one
  // offset too many and left the header cropped at the top — the two symptoms
  // measured equal, both being `vv.offsetTop`. Anchoring to `offsetTop`/`height`
  // drops `window.innerHeight` from the equation entirely and fixes both edges.
  // It is also self-disabling under `interactive-widget=resizes-content`, where
  // `offsetTop` is 0 and `vv.height` already equals the layout viewport.
  //
  // Two constraints worth keeping. Writes are coalesced into one rAF because
  // `scroll` fires continuously during iOS rubber-banding, and writing per event
  // is what made the first attempt judder (3969135b dropped the scroll listener
  // over exactly that, at the cost of freezing `offsetTop` at 0). And this must
  // NOT be expressed as a `transform`: that would turn the shell into a
  // containing block for the 41 `fixed inset-0` overlays nested inside it.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    let frame = 0;
    const write = () => {
      frame = 0;
      // Pinch-zoom shrinks the visual viewport too. Following it there would
      // re-lay-out the entire app inside the magnified region, so hand the
      // shell back to plain `inset-0` until the user zooms out. iOS Safari
      // ignores `user-scalable=no`, so this is reachable despite the meta tag.
      // The 1.05 is float tolerance, not a behavioural threshold — the
      // smallest deliberate pinch lands well above it.
      const geometry = getShellVisualViewportGeometry(vv);
      if (!geometry) {
        root.style.removeProperty('--vv-top');
        root.style.removeProperty('--vv-height');
        return;
      }
      root.style.setProperty('--vv-top', `${geometry.top}px`);
      root.style.setProperty('--vv-height', `${geometry.height}px`);
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(write);
    };
    // The two sources are not equally trustworthy. A `resize` is the keyboard
    // itself changing size — react at once. A `scroll` is often the browser
    // re-running scroll-into-view *because* we just moved the composer, so
    // reacting to it immediately closes a feedback loop and the shell
    // oscillates until it settles (measured on Android before the viewport meta
    // key was added; still reachable on WebKit and pre-133 Firefox, which ignore
    // that key). Waiting for the stream to go quiet breaks the loop and also
    // stops the shell chasing iOS rubber-band bounces — the regression that made
    // 3969135b drop this listener entirely. A resize also re-arms the settle
    // pass, so the final offset is picked up once the keyboard stops moving.
    const settleMs = 150;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const scheduleSettled = () => {
      clearTimeout(settle);
      settle = setTimeout(schedule, settleMs);
    };
    const onResize = () => {
      schedule();
      scheduleSettled();
    };
    write();
    vv.addEventListener('resize', onResize);
    vv.addEventListener('scroll', scheduleSettled);
    return () => {
      clearTimeout(settle);
      if (frame) cancelAnimationFrame(frame);
      vv.removeEventListener('resize', onResize);
      vv.removeEventListener('scroll', scheduleSettled);
      root.style.removeProperty('--vv-top');
      root.style.removeProperty('--vv-height');
    };
  }, []);

  // nit (qa-critic): مذكرة حتى لا تُعاد العملية في كل تصيير لمكوّن AppContent.
  const settingsProjects = useMemo(
    () => sidebarSharedProps.projects.map(normalizeProjectForSettings),
    [sidebarSharedProps.projects],
  );

  return (
    <div
      className="fixed inset-0 flex bg-background"
      // `--shell-safe-top` is the notch inset in standalone mode and 0 in a tab
      // (index.css). It is composed here rather than left to the
      // `body.pwa-mode .fixed.inset-0` rule, which an inline style outranks.
      style={{
        top: 'calc(var(--vv-top, 0px) + var(--shell-safe-top, 0px))',
        height: 'calc(var(--vv-height, 100%) - var(--shell-safe-top, 0px))',
        bottom: 'auto',
      }}
    >
      <BuildUpdateBanner />
      {!isMobile ? (
        <div className="sidebar-host-panel h-full flex-shrink-0">
          <Sidebar
            {...sidebarSharedProps}
            activeProjectTool={activeTab}
            onOpenProjectTool={openProjectTool}
            onProjectToolbarPresence={setProjectToolbarId}
            terminals={sidebarTerminalsProps}
            onSectionChange={handleSidebarSectionChange}
            scheduledMessagesCount={scheduledSummary.total}
            scheduledMessagesEnabled={scheduledCenterEnabled}
            scheduledMessagesActive={isScheduledRoute}
            onOpenScheduledMessages={() => {
              navigate('/scheduled');
              if (isMobile) setSidebarOpen(false);
            }}
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
            className={`relative h-full w-[85vw] max-w-sm transform bg-card transition-transform duration-150 ease-out sm:w-80 ${sidebarOpen ? 'translate-x-0' : 'ltr:-translate-x-full rtl:translate-x-full'
              }`}
            onClick={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
          >
            <Sidebar
              {...sidebarSharedProps}
              activeProjectTool={activeTab}
              onOpenProjectTool={openProjectTool}
              onProjectToolbarPresence={setProjectToolbarId}
              terminals={sidebarTerminalsProps}
              onSectionChange={handleSidebarSectionChange}
              scheduledMessagesCount={scheduledSummary.total}
              scheduledMessagesEnabled={scheduledCenterEnabled}
              scheduledMessagesActive={isScheduledRoute}
              onOpenScheduledMessages={() => {
                navigate('/scheduled');
                setSidebarOpen(false);
              }}
            />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {isScheduledRoute ? (
          <ScheduledMessagesCenterRoute
            projects={sidebarSharedProps.projects}
            onOpenSession={(targetSessionId) => {
              navigate(`/session/${targetSessionId}`);
              if (isMobile) setSidebarOpen(false);
            }}
          />
        ) : <MainContent
          hideProjectTools={Boolean(projectToolbarId && projectToolbarId === selectedProject?.projectId)}
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
              openSettings();
            }
          }}
          externalMessageUpdate={externalMessageUpdate}
          newSessionTrigger={newSessionTrigger}
          onNewSession={selectedProject ? () => handleNewSession(selectedProject) : undefined}
          terminals={terminalItems}
          selectedTerminalId={selectedTerminalId}
          onRenameTerminal={renameTerminal}
          onDeleteTerminal={handleDeleteTerminal}
          onCloseTerminal={handleCloseTerminal}
          onRefreshTerminals={refreshTerminals}
          onSelectedSessionClosedChange={handleSelectedSessionClosedChange}
          deepLinkResolution={deepLinkResolution}
          onRetryDeepLink={retryDeepLinkResolution}
        />}
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

      {/* B-557: الإعدادات تُصيَّر هنا لا داخل Sidebar حتى لا تُعاد تركيبها
          عند تقلّب isMobile عبر عتبة 768px. مكانها في شجرة React ثابت بغضّ
          النظر عن حجم النافذة، فحالة الكتابة داخل نموذج المفتاح لا تضيع. */}
      {showSettings && ReactDOM.createPortal(
        <Settings
          isOpen={showSettings}
          onClose={closeSettings}
          projects={settingsProjects}
          initialTab={settingsInitialTab}
          deepLink={settingsDeepLink}
        />,
        document.body,
      )}
    </div>
  );
}
