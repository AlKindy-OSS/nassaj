import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import ChatInterface from '../../chat/view/ChatInterface';
import FileTree from '../../file-tree/view/FileTree';
import StandaloneShell from '../../standalone-shell/view/StandaloneShell';
import Shell from '../../shell/view/Shell';
import OneShotRunStrip from '../../shell/view/subcomponents/OneShotRunStrip';
import {
  claimOneShotLaunch,
  consumeOneShotRequest,
  isLiveOneShotRun,
  markOneShotFinished,
  oneShotRunsKey,
  markOneShotRefused,
  resolveOneShotCapture,
  selectOneShotRun,
  startOneShotRun,
  useOneShotRuns,
  usePendingOneShotRequest,
} from '../../shell/oneShot/oneShotRunsStore';
import type { OneShotFrame, ShellErrorInfo } from '../../shell/types/types';
import { isOneShotRefusalCode } from '../../shell/utils/reconnect';
import { getProviderDisplayName } from '../../chat/constants/providerCapabilities';
import GitPanel from '../../git-panel/view/GitPanel';
import type { MainContentProps } from '../types/types';
import type { SessionDeepLinkResolution } from '../../../hooks/useProjectsState';
import { usePaletteOpsRegister } from '../../../contexts/PaletteOpsContext';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import EditorSidebar from '../../code-editor/view/EditorSidebar';
import { ProjectBoardPanel } from '../../project-board';
import { WikiPanel } from '../../wiki';
import TerminalsPanel from '../../terminals/view/TerminalsPanel';
import { canUseTerminals } from '../../terminals/utils/canUseTerminals';
import { useAuth } from '../../auth';

import MainContentHeader from './subcomponents/MainContentHeader';
import MainContentStateView from './subcomponents/MainContentStateView';
import ErrorBoundary from './ErrorBoundary';

/**
 * B-1469 round 4: a brand-new session's `session_created` navigates this tab
 * to `/session/:id` (useChatRealtimeHandlers) *before* that id has reached the
 * project's session list (REST/`projects_updated` lag) — the exact shape
 * `useProjectsState`'s deep-link effect treats as "an unresolved deep link",
 * flipping `deepLinkResolution.status` to `loading` for the brief window
 * until its own `api.sessionContext` round-trip (or the session list catching
 * up) resolves it. Showing `MainContentStateView` for that window swapped out
 * the whole chat tree, unmounting `ChatInterface` — and with it its own
 * `useSessionStore()` instance and `pendingViewSessionRef` — a few dozen ms
 * after the optimistic user bubble had already been written into the
 * (about-to-be-discarded) store. `processingSessions` already names exactly
 * "a session this tab is actively running right now" (stamped in the same
 * `session_created` handler, before it navigates) — a strictly stronger
 * signal than the deep-link machinery has, with no server round-trip needed —
 * so a session it already vouches for skips the placeholder entirely instead
 * of waiting for the deep-link resolver's own confirmation.
 *
 * Scoped to `status === 'loading'` only (qa-critic round 1): `forbidden` and
 * `not_found` are the resolver's own DEFINITIVE verdicts, not a race with it
 * — they must always surface, even for an id `processingSessions` still
 * names. `processingSessions` is also filled from session-status frames
 * (`useChatRealtimeHandlers.ts`) and can go stale (a tab left open past a
 * session's real lifetime), so it is trusted only to skip the transient
 * "still resolving" window, never to override a resolved rejection.
 */
export function shouldShowDeepLinkPlaceholder(
  deepLinkResolution: SessionDeepLinkResolution,
  processingSessions: Set<string>,
): boolean {
  if (deepLinkResolution.status === 'idle') return false;
  if (deepLinkResolution.status === 'loading') {
    return !processingSessions.has(deepLinkResolution.sessionId);
  }
  return true;
}

function MainContent({
  selectedProject,
  selectedSession,
  activeTab,
  setActiveTab,
  hideProjectTools,
  ws,
  sendMessage,
  latestMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onInputFocusChange,
  onSessionActive,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  processingSessions,
  onNavigateToSession,
  onShowSettings,
  externalMessageUpdate,
  newSessionTrigger,
  onNewSession,
  terminals,
  selectedTerminalId,
  onRenameTerminal,
  onDeleteTerminal,
  onCloseTerminal,
  onRefreshTerminals,
  onSelectedSessionClosedChange,
  deepLinkResolution,
  onRetryDeepLink,
}: MainContentProps) {
  const [sessionHeaderTarget, setSessionHeaderTarget] = useState<HTMLDivElement | null>(null);
  const { t } = useTranslation('common');
  const { preferences } = useUiPreferences();
  const { autoExpandTools, showRawParameters, showThinking, showToolCalls, autoScrollToBottom, sendByCtrlEnter } = preferences;

  const {
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    closePromptOpen,
    handleDirtyChange,
    handleRequestClose,
    handleDismissClosePrompt,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
  } = useEditorSidebar({
    selectedProject,
    isMobile,
    sessionId: selectedSession?.id ?? null,
    isNewSessionScope: activeTab === 'chat',
  });

  // Project-board links (e.g. decision documents) are read-first: markdown
  // files open in the editor sidebar already rendered as a preview.
  const handleBoardFileOpen = useCallback(
    (filePath: string) => handleFileOpen(filePath, null, { openMarkdownPreview: true }),
    [handleFileOpen],
  );

  usePaletteOpsRegister({
    openFile: (filePath: string) => {
      setActiveTab('files');
      handleFileOpen(filePath);
    },
  });

  // Terminals are an admin-only surface (ADR-063 amend). The server rejects a
  // non-privileged user at REST + WS regardless, but this guard stops a stale
  // deep-link/tab from rendering an empty, error-looping terminal panel.
  const { user } = useAuth();
  const terminalsAllowed = canUseTerminals(user?.role);

  // T-2037: composer one-shot runs. A confirmed composer submit leaves a
  // request; this is the only place that turns it into a run (and a runId),
  // then shows it in the Shell tab. The chat transcript is never touched.
  // Runs are scoped to the signed-in user AND the project (qa critical-1).
  const projectKey = oneShotRunsKey(user?.id ?? user?.username, selectedProject?.projectId);
  const pendingOneShot = usePendingOneShotRequest();
  const { runs: oneShotRuns, activeRunId } = useOneShotRuns(projectKey);
  const activeOneShot = oneShotRuns.find((run) => run.runId === activeRunId) ?? null;

  useEffect(() => {
    if (!pendingOneShot || !projectKey) return;
    const request = consumeOneShotRequest();
    if (!request) return;
    startOneShotRun(projectKey, request.command);
    setActiveTab('shell');
  }, [pendingOneShot, projectKey, setActiveTab]);

  const handleSelectOneShot = useCallback(
    (runId: string | null) => {
      if (projectKey) selectOneShotRun(projectKey, runId);
    },
    [projectKey],
  );

  const handleOneShotFrame = useCallback(
    (frame: OneShotFrame) => {
      if (!projectKey) return;
      if (frame.type === 'oneshot_finished') {
        markOneShotFinished(projectKey, frame.runId, frame);
        return;
      }
      resolveOneShotCapture(frame.runId, frame.type === 'oneshot_capture' ? frame : null);
    },
    [projectKey],
  );

  const activeOneShotId = activeOneShot?.runId ?? null;
  const handleOneShotError = useCallback(
    (error: ShellErrorInfo | null) => {
      if (!projectKey || !activeOneShotId || !error || !isOneShotRefusalCode(error.code ?? '')) return;
      markOneShotRefused(projectKey, activeOneShotId, error.code ?? 'unknown');
    },
    [activeOneShotId, projectKey],
  );

  const handleOneShotAttached = useCallback(() => setActiveTab('chat'), [setActiveTab]);

  // A shell is mounted only for a run started in THIS page lifetime while it
  // runs, and stays mounted (output visible, capture possible) once it finishes
  // there. Restored, finished-elsewhere and refused runs are static entries:
  // nothing is mounted, so nothing can send an init for them.
  const mountedOneShotRef = useRef<string | null>(null);
  const mountOneShotShell = Boolean(
    activeOneShot &&
      isLiveOneShotRun(activeOneShot.runId) &&
      activeOneShot.status !== 'refused' &&
      (activeOneShot.status === 'running' || mountedOneShotRef.current === activeOneShot.runId),
  );
  mountedOneShotRef.current = mountOneShotShell && activeOneShot ? activeOneShot.runId : null;

  const agentProviderName = getProviderDisplayName(
    selectedSession?.__provider || localStorage.getItem('selected-provider') || 'claude',
  );

  if (isLoading) {
    return <MainContentStateView mode="loading" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  // See `shouldShowDeepLinkPlaceholder` above (B-1469 round 4) for why a
  // session `processingSessions` already vouches for skips this placeholder.
  if (shouldShowDeepLinkPlaceholder(deepLinkResolution, processingSessions)) {
    return (
      <MainContentStateView
        mode="deep-link"
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        deepLinkResolution={deepLinkResolution}
        onRetryDeepLink={onRetryDeepLink}
      />
    );
  }

  // Standalone terminals are project-independent (T-939): render the panel
  // full-area whenever the terminal surface is active, before the
  // `!selectedProject` gate (mirrors the wiki precedent below).
  if (activeTab === 'terminal' && terminalsAllowed) {
    return (
      <TerminalsPanel
        terminals={terminals}
        selectedTerminalId={selectedTerminalId}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        onRenameTerminal={onRenameTerminal}
        onDeleteTerminal={onDeleteTerminal}
        onCloseTerminal={onCloseTerminal}
        onRequestListRefresh={onRefreshTerminals}
      />
    );
  }

  // Wiki is project-independent — show it even when no project is selected.
  if (!selectedProject && activeTab !== 'wiki') {
    return <MainContentStateView mode="empty" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  if (!selectedProject && activeTab === 'wiki') {
    return (
      <div className="flex h-full flex-col">
        <div className="pwa-header-safe flex-shrink-0 bg-background">
          <div className="app-top-rail flex items-center justify-between gap-3 px-3 sm:px-4">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {isMobile && (
                <button
                  type="button"
                  onClick={onMenuClick}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"
                  aria-label={t('nav.openMenu')}
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* B-122: ErrorBoundary يمنع انهيار الصفحة عند خطأ FocusTrap أو WikiPanel */}
          <ErrorBoundary
            showDetails={false}
            fallbackLabel="تعذّر عرض هذه الصفحة"
            retryLabel="إعادة تحميل"
          >
            <WikiPanel />
          </ErrorBoundary>
        </div>
      </div>
    );
  }

  // At this point selectedProject is guaranteed non-null (wiki-without-project
  // and loading states are handled by the early returns above).
  const project = selectedProject!;

  return (
    <div className="flex h-full flex-col">
      <MainContentHeader
        sessionHeaderRef={setSessionHeaderTarget}
        hideProjectTools={hideProjectTools}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        selectedProject={project}
        selectedSession={selectedSession}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className={`flex min-h-0 min-w-[200px] flex-col overflow-hidden ${editorExpanded ? 'hidden' : ''} flex-1`}>
          <div className={`h-full ${activeTab === 'chat' ? 'block' : 'hidden'}`}>
            <ErrorBoundary showDetails>
              <ChatInterface
                sessionHeaderTarget={sessionHeaderTarget}
                selectedProject={project}
                selectedSession={selectedSession}
                ws={ws}
                sendMessage={sendMessage}
                latestMessage={latestMessage}
                onFileOpen={handleFileOpen}
                onInputFocusChange={onInputFocusChange}
                onSessionActive={onSessionActive}
                onSessionInactive={onSessionInactive}
                onSessionProcessing={onSessionProcessing}
                onSessionNotProcessing={onSessionNotProcessing}
                processingSessions={processingSessions}
                onNavigateToSession={onNavigateToSession}
                onShowSettings={onShowSettings}
                autoExpandTools={autoExpandTools}
                showRawParameters={showRawParameters}
                showThinking={showThinking}
                showToolCalls={showToolCalls}
                autoScrollToBottom={autoScrollToBottom}
                sendByCtrlEnter={sendByCtrlEnter}
                externalMessageUpdate={externalMessageUpdate}
                newSessionTrigger={newSessionTrigger}
                onNewSession={onNewSession}
                onSelectedSessionClosedChange={onSelectedSessionClosedChange}
              />
            </ErrorBoundary>
          </div>

          {activeTab === 'files' && (
            <div className="h-full overflow-hidden">
              <FileTree selectedProject={project} onFileOpen={handleFileOpen} />
            </div>
          )}

          {activeTab === 'shell' && (
            <div className="flex h-full w-full flex-col overflow-hidden">
              {oneShotRuns.length > 0 && (
                <OneShotRunStrip
                  providerName={agentProviderName}
                  runs={oneShotRuns}
                  activeRunId={activeOneShotId}
                  onSelect={handleSelectOneShot}
                  onAttached={handleOneShotAttached}
                />
              )}
              <div className="min-h-0 flex-1">
                {!activeOneShot ? (
                  <StandaloneShell
                    project={project}
                    session={selectedSession}
                    showHeader={false}
                    isActive={activeTab === 'shell'}
                  />
                ) : !mountOneShotShell ? (
                  // Static entry: refused, finished, or restored from storage.
                  // No shell is mounted, so no init can be sent for it.
                  <div className="flex h-full items-center justify-center bg-gray-900 p-6">
                    <pre dir="ltr" className="max-w-full overflow-auto whitespace-pre-wrap break-all font-mono text-sm text-gray-300">
                      $ {activeOneShot.command}
                    </pre>
                  </div>
                ) : (
                  <Shell
                    // Keyed by runId: switching runs remounts, and a remount
                    // only re-attaches to that same runId.
                    key={activeOneShot.runId}
                    selectedProject={project}
                    initialCommand={activeOneShot.command}
                    isPlainShell
                    autoConnect
                    isActive={activeTab === 'shell'}
                    oneShotRunId={activeOneShot.runId}
                    claimOneShotLaunch={claimOneShotLaunch}
                    onOneShotFrame={handleOneShotFrame}
                    onShellError={handleOneShotError}
                  />
                )}
              </div>
            </div>
          )}

          {activeTab === 'git' && (
            <div className="h-full overflow-hidden">
              {/* Project tools read the project root, independently of the open chat. */}
              <GitPanel
                selectedProject={project}
                isMobile={isMobile}
                onFileOpen={handleFileOpen}
              />
            </div>
          )}

          {activeTab === 'board' && (
            <div className="h-full overflow-hidden">
              <ErrorBoundary showDetails>
                <ProjectBoardPanel selectedProject={project} onFileOpen={handleBoardFileOpen} />
              </ErrorBoundary>
            </div>
          )}

          <div className={`h-full overflow-hidden ${activeTab === 'preview' ? 'block' : 'hidden'}`} />

          {activeTab === 'wiki' && (
            <div className="h-full overflow-hidden">
              {/* B-122: ErrorBoundary يمنع انهيار الصفحة عند خطأ FocusTrap أو WikiPanel */}
              <ErrorBoundary
                showDetails={false}
                fallbackLabel="تعذّر عرض هذه الصفحة"
                retryLabel="إعادة تحميل"
              >
                <WikiPanel />
              </ErrorBoundary>
            </div>
          )}

        </div>

        <EditorSidebar
          editingFile={editingFile}
          isMobile={isMobile}
          editorExpanded={editorExpanded}
          editorWidth={editorWidth}
          hasManualWidth={hasManualWidth}
          resizeHandleRef={resizeHandleRef}
          onResizeStart={handleResizeStart}
          onRequestClose={handleRequestClose}
          onCloseEditor={handleCloseEditor}
          closePromptOpen={closePromptOpen}
          onDirtyChange={handleDirtyChange}
          onDismissClosePrompt={handleDismissClosePrompt}
          onToggleEditorExpand={handleToggleEditorExpand}
          projectPath={project.path}
          fillSpace={activeTab === 'files'}
        />
      </div>
    </div>
  );
}

export default React.memo(MainContent);
