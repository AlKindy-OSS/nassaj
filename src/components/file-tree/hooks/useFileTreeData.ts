import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../utils/api';
import type { Project } from '../../../types/app';
import type { FileTreeNode } from '../types/types';

export type FileTreeDataError = 'tooLarge' | 'loadFailed' | null;

type FileTreeErrorResponseBody = {
  error?: string;
  code?: string;
  limit?: number;
};

type UseFileTreeDataResult = {
  files: FileTreeNode[];
  loading: boolean;
  error: FileTreeDataError;
  /** Only set when `error === 'tooLarge'`: the server's max entry count. */
  limit: number | null;
  refreshFiles: () => void;
};

export function useFileTreeData(selectedProject: Project | null): UseFileTreeDataResult {
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FileTreeDataError>(null);
  const [limit, setLimit] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const refreshFiles = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  useEffect(() => {
    // File-tree requests use the DB projectId; the backend resolves it to the
    // project's absolute path through the projects table.
    const projectId = selectedProject?.projectId;

    if (!projectId) {
      setFiles([]);
      setLoading(false);
      setError(null);
      setLimit(null);
      return;
    }

    // Abort previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    // Track mount state so aborted or late responses do not enqueue stale state updates.
    let isActive = true;

    const fetchFiles = async () => {
      if (isActive) {
        setLoading(true);
        setError(null);
        setLimit(null);
      }
      try {
        const response = await api.getFiles(projectId, { signal: abortControllerRef.current!.signal });

        if (!response.ok) {
          let body: FileTreeErrorResponseBody = {};
          try {
            body = (await response.json()) as FileTreeErrorResponseBody;
          } catch {
            // Non-JSON error body; fall through to the generic failure state.
          }
          console.error('File fetch failed:', response.status, body.error || response.statusText);
          if (isActive) {
            setFiles([]);
            if (response.status === 413 && body.code === 'FILE_TREE_TOO_LARGE') {
              setError('tooLarge');
              setLimit(typeof body.limit === 'number' ? body.limit : null);
            } else {
              setError('loadFailed');
            }
          }
          return;
        }

        const data = (await response.json()) as FileTreeNode[];
        if (isActive) {
          setFiles(data);
        }
      } catch (error_) {
        if ((error_ as { name?: string }).name === 'AbortError') {
          return;
        }

        console.error('Error fetching files:', error_);
        if (isActive) {
          setFiles([]);
          setError('loadFailed');
        }
      } finally {
        if (isActive) {
          setLoading(false);
        }
      }
    };

    void fetchFiles();

    return () => {
      isActive = false;
      abortControllerRef.current?.abort();
    };
  }, [selectedProject?.projectId, refreshKey]);

  return {
    files,
    loading,
    error,
    limit,
    refreshFiles,
  };
}
