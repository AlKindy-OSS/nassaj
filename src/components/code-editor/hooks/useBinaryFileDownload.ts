import { useCallback, useState } from 'react';

import { api } from '../../../utils/api';
import { SECRET_FILE_DECLINED, requestWithSecretConfirmation } from '../../../utils/secretFileConfirmation';

type DownloadState = {
  isDownloading: boolean;
  hasError: boolean;
  download: () => Promise<void>;
};

/** Saves a blob through a temporary anchor, then releases the object URL. */
function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/**
 * Binary-safe download: streams raw bytes from the blob endpoint.
 * Never use the text-buffer download for binary files (it would be empty).
 */
export function useBinaryFileDownload(
  projectId: string | undefined,
  filePath: string,
  fileName: string,
  /** B-1689: chat session whose overlay copy to download, when opened from chat. */
  sessionId: string | null = null,
): DownloadState {
  const [isDownloading, setIsDownloading] = useState(false);
  const [hasError, setHasError] = useState(false);

  const download = useCallback(async () => {
    if (!projectId || isDownloading) return;
    setIsDownloading(true);
    setHasError(false);
    try {
      // B-1593: a secrets file (e.g. a project SQLite database) asks first.
      const response = await requestWithSecretConfirmation(
        (confirmSecret) => api.readFileBlob(projectId, filePath, { confirmSecret, sessionId }),
        { fileName },
      );
      if (response === SECRET_FILE_DECLINED) return;
      if (!response.ok) throw new Error(`Download failed (${response.status})`);
      saveBlob(await response.blob(), fileName);
    } catch (error) {
      console.error('Binary file download failed:', error);
      setHasError(true);
    } finally {
      setIsDownloading(false);
    }
  }, [projectId, filePath, fileName, sessionId, isDownloading]);

  return { isDownloading, hasError, download };
}
