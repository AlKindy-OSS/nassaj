import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../../utils/api';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import type { ProjectBoardResponse } from '../types';

type BoardWebSocketMessage = {
  type?: string;
  projectId?: string;
};

/**
 * Fetches the board projection for a project and keeps it live:
 * the server watches docs/project-state.json + ARCHITECTURE files with
 * chokidar and broadcasts `project-board-updated`; we simply re-fetch.
 */
export function useProjectBoard(projectId: string | null | undefined) {
  const [board, setBoard] = useState<ProjectBoardResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const { latestMessage } = useWebSocket();
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const refresh = useCallback(async (targetProjectId: string) => {
    try {
      const response = await api.projectBoard(targetProjectId);
      if (projectIdRef.current !== targetProjectId) {
        return; // stale response for a previously selected project
      }
      if (!response.ok) {
        setLoadError(true);
        return;
      }
      const data = (await response.json()) as ProjectBoardResponse;
      if (projectIdRef.current !== targetProjectId) {
        return;
      }
      setBoard(data);
      setLoadError(false);
    } catch {
      if (projectIdRef.current === targetProjectId) {
        setLoadError(true);
      }
    } finally {
      if (projectIdRef.current === targetProjectId) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    setBoard(null);
    setLoadError(false);
    if (!projectId) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    void refresh(projectId);
  }, [projectId, refresh]);

  useEffect(() => {
    const message = latestMessage as BoardWebSocketMessage | null;
    if (
      message?.type === 'project-board-updated' &&
      projectId &&
      message.projectId === projectId
    ) {
      void refresh(projectId);
    }
  }, [latestMessage, projectId, refresh]);

  return { board, isLoading, loadError };
}
