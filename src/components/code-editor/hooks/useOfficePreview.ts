import { useEffect, useState } from 'react';

import { api } from '../../../utils/api';
import { OFFICE_PREVIEW_MAX_BYTES, type OfficeFormat } from '../utils/officeDocument';
import type { OfficePreviewResult } from '../utils/office/parseOfficeFile';
import { PreviewTooLargeError, readResponseBounded } from '../utils/office/readBounded';

export type OfficePreviewState =
  | { status: 'loading' }
  | { status: 'ready'; result: OfficePreviewResult }
  | { status: 'tooLarge' }
  /** The server wants explicit confirmation for a secrets file (HTTP 428). */
  | { status: 'secret' }
  | { status: 'error' };

type UseOfficePreviewArgs = {
  projectId?: string;
  filePath: string;
  format: OfficeFormat;
  /** B-1689: chat session whose overlay copy to preview, when opened from chat. */
  sessionId?: string | null;
};

class SecretFileError extends Error {}

/** Fetches the raw bytes, stopping the download once it passes the size cap. */
async function fetchOfficeBytes(
  projectId: string,
  filePath: string,
  sessionId: string | null,
  signal: AbortSignal,
): Promise<Uint8Array> {
  // No confirmSecret here: a secrets file stays closed (fail closed) and the
  // user is told why instead of seeing a generic failure.
  const response: Response = await api.readFileBlob(projectId, filePath, { signal, sessionId });
  if (response.status === 428) throw new SecretFileError();
  if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
  return readResponseBounded(response, OFFICE_PREVIEW_MAX_BYTES);
}

/**
 * Loads and parses an office file once per file for read-only preview. Parsers
 * are loaded on demand so none ship in the main bundle; closing or switching
 * the file aborts both the download and the parse. Theme changes do not
 * re-run this: the caller derives themed output from the result.
 */
export function useOfficePreview({ projectId, filePath, format, sessionId = null }: UseOfficePreviewArgs): OfficePreviewState {
  const [state, setState] = useState<OfficePreviewState>({ status: 'loading' });

  useEffect(() => {
    if (!projectId) {
      setState({ status: 'error' });
      return undefined;
    }
    const controller = new AbortController();
    setState({ status: 'loading' });

    const load = async () => {
      try {
        const bytes = await fetchOfficeBytes(projectId, filePath, sessionId, controller.signal);
        const { parseOfficeFile } = await import('../utils/office/parseOfficeFile');
        const result = await parseOfficeFile(format, bytes, controller.signal);
        if (!controller.signal.aborted) setState({ status: 'ready', result });
      } catch (error: unknown) {
        if (controller.signal.aborted) return;
        if (error instanceof PreviewTooLargeError) {
          setState({ status: 'tooLarge' });
          return;
        }
        if (error instanceof SecretFileError) {
          setState({ status: 'secret' });
          return;
        }
        // Only the error class is logged; details may quote file content.
        console.error('Office preview failed:', error instanceof Error ? error.name : 'unknown error');
        setState({ status: 'error' });
      }
    };

    void load();
    return () => controller.abort();
  }, [projectId, filePath, format, sessionId]);

  return state;
}
