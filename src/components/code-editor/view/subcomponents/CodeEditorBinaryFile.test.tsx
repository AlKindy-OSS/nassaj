/**
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 * Binary file viewer: Download button uses the raw-bytes endpoint.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readFileBlob = vi.fn();
vi.mock('../../../../utils/api', () => ({ api: { readFileBlob: (...a: unknown[]) => readFileBlob(...a) } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../../../document-sharing/DocumentShareButton', () => ({ default: () => null }));

import CodeEditorBinaryFile from './CodeEditorBinaryFile';

const file = { name: 'report.docx', path: '/p/report.docx' };
const renderIt = (projectId: string | undefined = 'proj-1') =>
  render(
    <CodeEditorBinaryFile
      file={file as never}
      projectId={projectId}
      isSidebar
      isFullscreen={false}
      onClose={() => {}}
      onToggleFullscreen={() => {}}
      title="t"
      message="m"
    />,
  );

describe('CodeEditorBinaryFile download', () => {
  beforeEach(() => {
    readFileBlob.mockReset();
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the download button', () => {
    renderIt();
    expect(screen.getByRole('button', { name: 'binaryFile.download' })).toBeTruthy();
  });

  it('fetches raw bytes with project id and path, then revokes the URL', async () => {
    readFileBlob.mockResolvedValue({ ok: true, blob: async () => new Blob(['x']) });
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: 'binaryFile.download' }));
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x'));
    expect(readFileBlob).toHaveBeenCalledWith('proj-1', '/p/report.docx');
  });

  it('shows an error when the response is not ok', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    readFileBlob.mockResolvedValue({ ok: false, status: 500 });
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: 'binaryFile.download' }));
    expect((await screen.findByRole('alert')).textContent).toBe('binaryFile.downloadError');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
