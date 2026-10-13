import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { Project } from '../../../types/app';
import type { CodeEditorDiffInfo, CodeEditorFile } from '../types/types';

type UseEditorSidebarOptions = {
  selectedProject: Project | null;
  isMobile: boolean;
  /** Active chat session id; the open file belongs to the session it was opened in. */
  sessionId?: string | null;
  /**
   * True while the view is the chat of a not-yet-created session (no session
   * selected, chat tab). A file opened there survives the session receiving
   * its real id; a file opened elsewhere (e.g. the Files view) does not.
   */
  isNewSessionScope?: boolean;
  initialWidth?: number;
};

export const useEditorSidebar = ({
  selectedProject,
  isMobile,
  sessionId = null,
  isNewSessionScope = true,
  initialWidth = 600,
}: UseEditorSidebarOptions) => {
  const [editingFile, setEditingFile] = useState<CodeEditorFile | null>(null);
  const [editorWidth, setEditorWidth] = useState(initialWidth);
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [hasManualWidth, setHasManualWidth] = useState(false);
  const resizeHandleRef = useRef<HTMLDivElement | null>(null);

  const [closePromptOpen, setClosePromptOpen] = useState(false);
  // Mirrors the open editor's dirty flag so close paths that run outside the
  // editor (session switch, tab unload) can see it without re-rendering.
  const dirtyRef = useRef(false);
  const editingFileRef = useRef<CodeEditorFile | null>(null);
  editingFileRef.current = editingFile;
  // Context the open file was opened in: true only for a new-session chat.
  const openedInNewSessionRef = useRef(false);
  const newSessionScopeRef = useRef(isNewSessionScope);
  newSessionScopeRef.current = isNewSessionScope;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  // File the user asked to open while the current one has unsaved edits; it is
  // opened once they choose Save or Discard, and dropped on Keep editing.
  const pendingFileRef = useRef<CodeEditorFile | null>(null);

  const handleFileOpen = useCallback(
    (
      filePath: string,
      diffInfo: CodeEditorDiffInfo | null = null,
      options: { openMarkdownPreview?: boolean } = {},
    ) => {
      const normalizedPath = filePath.replace(/\\/g, '/');
      const fileName = normalizedPath.split('/').pop() || filePath;

      const nextFile: CodeEditorFile = {
        name: fileName,
        path: filePath,
        // DB projectId is forwarded to the editor so it can read/save files
        // via `/api/projects/:projectId/file` endpoints.
        projectId: selectedProject?.projectId,
        diffInfo,
        openMarkdownPreview: Boolean(options.openMarkdownPreview),
      };

      const openedInNewSession = !sessionIdRef.current && newSessionScopeRef.current;
      const current = editingFileRef.current;
      if (dirtyRef.current && current && current.path !== filePath) {
        pendingFileRef.current = nextFile;
        setClosePromptOpen(true);
        return;
      }
      openedInNewSessionRef.current = openedInNewSession;
      setEditingFile(nextFile);
    },
    [selectedProject?.projectId],
  );

  const handleDirtyChange = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);

  /**
   * Leave the current file unconditionally (after Save or Discard): opens the
   * file that was waiting behind the prompt, otherwise closes the editor.
   */
  const handleCloseEditor = useCallback(() => {
    dirtyRef.current = false;
    setClosePromptOpen(false);
    const pending = pendingFileRef.current;
    pendingFileRef.current = null;
    if (pending) {
      openedInNewSessionRef.current = !sessionIdRef.current && newSessionScopeRef.current;
      setEditingFile(pending);
      return;
    }
    setEditingFile(null);
    setEditorExpanded(false);
  }, []);

  /** Close, but ask first when the open file has unsaved edits. */
  const handleRequestClose = useCallback(() => {
    if (dirtyRef.current) {
      pendingFileRef.current = null;
      setClosePromptOpen(true);
      return;
    }
    handleCloseEditor();
  }, [handleCloseEditor]);

  const handleDismissClosePrompt = useCallback(() => {
    pendingFileRef.current = null;
    setClosePromptOpen(false);
  }, []);

  // Reload/close of the browser tab with unsaved edits: native confirmation.
  useEffect(() => {
    if (!editingFile) {
      return undefined;
    }
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
      }
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [editingFile]);

  // The file belongs to the session it was opened in: leaving a real session
  // for another one (or for a new-session screen) closes it. null -> id keeps a
  // file opened in a new-session chat (the session receiving its real id), but
  // closes one opened outside any session (Files view) when the user picks a
  // session.
  const previousSessionIdRef = useRef(sessionId);
  useEffect(() => {
    const previous = previousSessionIdRef.current;
    previousSessionIdRef.current = sessionId;
    const pickedExistingSession =
      !previous && Boolean(sessionId) && !openedInNewSessionRef.current;
    if ((previous && previous !== sessionId) || pickedExistingSession) {
      // Navigation already happened; the old file stays mounted (with its own
      // project id) until the user answers the unsaved-changes prompt.
      handleRequestClose();
    }
  }, [sessionId, handleRequestClose]);

  const handleToggleEditorExpand = useCallback(() => {
    setEditorExpanded((previous) => !previous);
  }, []);

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (isMobile) {
        return;
      }

      // After first drag interaction, the editor width is user-controlled.
      setHasManualWidth(true);
      setIsResizing(true);
      event.preventDefault();
    },
    [isMobile],
  );

  useEffect(() => {
    const handleMouseMove = (event: globalThis.MouseEvent) => {
      if (!isResizing) {
        return;
      }

      // Get the main container (parent of EditorSidebar's parent) that contains both left content and editor
      const editorContainer = resizeHandleRef.current?.parentElement;
      const mainContainer = editorContainer?.parentElement;
      if (!mainContainer) {
        return;
      }

      const containerRect = mainContainer.getBoundingClientRect();

      // The editor pane is the LAST child of a plain (non-reversed) flex row, so
      // the browser parks it against the container's *inline-end* edge: the right
      // edge under LTR, the left edge under RTL. Hard-coding `containerRect.right`
      // inverted the drag in Arabic — pulling the handle towards the editor made
      // it narrower. Read the direction actually in effect instead of assuming.
      const isRtl = getComputedStyle(mainContainer).direction === 'rtl';
      const newWidth = isRtl
        ? event.clientX - containerRect.left
        : containerRect.right - event.clientX;

      const minWidth = 300;
      const maxWidth = containerRect.width * 0.8;

      if (newWidth >= minWidth && newWidth <= maxWidth) {
        setEditorWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  return {
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
  };
};
