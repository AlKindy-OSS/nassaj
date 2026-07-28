import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { Project } from '../../../types/app';
import type { CodeEditorDiffInfo, CodeEditorFile } from '../types/types';

type UseEditorSidebarOptions = {
  selectedProject: Project | null;
  isMobile: boolean;
  initialWidth?: number;
};

export const useEditorSidebar = ({
  selectedProject,
  isMobile,
  initialWidth = 600,
}: UseEditorSidebarOptions) => {
  const [editingFile, setEditingFile] = useState<CodeEditorFile | null>(null);
  const [editorWidth, setEditorWidth] = useState(initialWidth);
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [hasManualWidth, setHasManualWidth] = useState(false);
  const resizeHandleRef = useRef<HTMLDivElement | null>(null);

  const handleFileOpen = useCallback(
    (
      filePath: string,
      diffInfo: CodeEditorDiffInfo | null = null,
      options: { openMarkdownPreview?: boolean } = {},
    ) => {
      const normalizedPath = filePath.replace(/\\/g, '/');
      const fileName = normalizedPath.split('/').pop() || filePath;

      setEditingFile({
        name: fileName,
        path: filePath,
        // DB projectId is forwarded to the editor so it can read/save files
        // via `/api/projects/:projectId/file` endpoints.
        projectId: selectedProject?.projectId,
        diffInfo,
        openMarkdownPreview: Boolean(options.openMarkdownPreview),
      });
    },
    [selectedProject?.projectId],
  );

  const handleCloseEditor = useCallback(() => {
    setEditingFile(null);
    setEditorExpanded(false);
  }, []);

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
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
  };
};
