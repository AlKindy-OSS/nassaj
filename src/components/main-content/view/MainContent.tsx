import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import ChatInterface from '../../chat/view/ChatInterface';
import FileTree from '../../file-tree/view/FileTree';
import StandaloneShell from '../../standalone-shell/view/StandaloneShell';
import GitPanel from '../../git-panel/view/GitPanel';
import type { MainContentProps } from '../types/types';
import { usePaletteOpsRegister } from '../../../contexts/PaletteOpsContext';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import EditorSidebar from '../../code-editor/view/EditorSidebar';
import { ProjectBoardPanel } from '../../project-board';
import { WikiPanel } from '../../wiki';
import TerminalsPanel from '../../terminals/view/TerminalsPanel';
import { useAuth } from '../../auth';

import MainContentHeader from './subcomponents/MainContentHeader';
import MainContentStateView from './subcomponents/MainContentStateView';
import ErrorBoundary from './ErrorBoundary';

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
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
  } = useEditorSidebar({
    selectedProject,
    isMobile,
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
  const canUseTerminals = user?.role === 'owner' || user?.role === 'admin';

  if (isLoading) {
    return <MainContentStateView mode="loading" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  if (deepLinkResolution.status !== 'idle') {
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
  if (activeTab === 'terminal' && canUseTerminals) {
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
            <div className="h-full w-full overflow-hidden">
              <StandaloneShell
                project={project}
                session={selectedSession}
                showHeader={false}
                isActive={activeTab === 'shell'}
              />
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
          onCloseEditor={handleCloseEditor}
          onToggleEditorExpand={handleToggleEditorExpand}
          projectPath={project.path}
          fillSpace={activeTab === 'files'}
        />
      </div>
    </div>
  );
}

export default React.memo(MainContent);
