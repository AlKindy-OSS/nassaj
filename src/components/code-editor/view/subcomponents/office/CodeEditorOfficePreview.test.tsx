/**
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 * Office preview: size cap (C5) and failures fall back to the download screen
 * without raw error text; viewers are read-only; theme switches never refetch
 * or reparse (C9); unmount cancels the parse; ids are unique (C13); long
 * sheets render in pages (C11).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readFileBlob = vi.fn();
const parseOfficeFile = vi.fn();
vi.mock('../../../../../utils/api', () => ({
  api: { readFileBlob: (...args: unknown[]) => readFileBlob(...args) },
}));
vi.mock('../../../utils/office/parseOfficeFile', () => ({
  parseOfficeFile: (...args: unknown[]) => parseOfficeFile(...args),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../../document-sharing/DocumentShareButton', () => ({ default: () => null }));

import { OFFICE_PREVIEW_MAX_BYTES, type OfficeFormat } from '../../../utils/officeDocument';
import { sanitizeDocument } from '../../../utils/office/sanitizeDocumentHtml';
import type { SheetData } from '../../../utils/office/sheetGrid';

import CodeEditorOfficePreview from './CodeEditorOfficePreview';
import { MAX_DISPLAY_CELL_CHARS, MAX_DISPLAY_PAGE_CHARS, ROWS_PER_PAGE } from './OfficeSpreadsheetView';

const okResponse = (size = 10, headers: Record<string, string> = {}) =>
  new Response(new Uint8Array(size), { status: 200, headers });

const props = (name: string, format: OfficeFormat, isDarkMode = false) => ({
  file: { name, path: `/p/${name}` } as never,
  format,
  projectId: 'proj-1',
  isSidebar: true,
  isFullscreen: false,
  isDarkMode,
  onClose: () => {},
  onToggleFullscreen: () => {},
});

const sheetOf = (name: string, text: string, overrides: Partial<SheetData> = {}): SheetData => ({
  name, rows: [[{ text, numeric: false }]], columnCount: 1, rtl: false, truncated: false, ...overrides,
});

describe('CodeEditorOfficePreview', () => {
  beforeEach(() => {
    readFileBlob.mockReset();
    parseOfficeFile.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('C5: falls back to the download screen when the declared size exceeds the cap', async () => {
    readFileBlob.mockImplementation(async () => okResponse(1, { 'content-length': String(OFFICE_PREVIEW_MAX_BYTES + 1) }));
    render(<CodeEditorOfficePreview {...props('big.docx', 'docx')} />);
    expect(await screen.findByText('officePreview.tooLarge')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'binaryFile.download' })).toBeTruthy();
    expect(parseOfficeFile).not.toHaveBeenCalled();
  });

  it('C5: stops a streamed download without Content-Length at the cap', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1024 * 1024;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    }, { highWaterMark: 0 });
    readFileBlob.mockResolvedValue(new Response(body, { status: 200 }));
    render(<CodeEditorOfficePreview {...props('chunked.xlsx', 'xlsx')} />);
    expect(await screen.findByText('officePreview.tooLarge')).toBeTruthy();
    expect(pulled).toBeLessThanOrEqual(OFFICE_PREVIEW_MAX_BYTES + 2 * 1024 * 1024);
    expect(parseOfficeFile).not.toHaveBeenCalled();
  });

  it('falls back to the download screen without raw error text when parsing fails', async () => {
    readFileBlob.mockImplementation(async () => okResponse());
    parseOfficeFile.mockRejectedValue(new Error('corrupt <secret path>'));
    render(<CodeEditorOfficePreview {...props('broken.xlsx', 'xlsx')} />);
    expect(await screen.findByText('officePreview.failed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'binaryFile.download' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('corrupt');
  });

  it('falls back when the content request fails, and requests through the api helper', async () => {
    readFileBlob.mockResolvedValue(new Response(null, { status: 403 }));
    render(<CodeEditorOfficePreview {...props('denied.pptx', 'pptx')} />);
    expect(await screen.findByText('officePreview.failed')).toBeTruthy();
    expect(readFileBlob).toHaveBeenCalledWith('proj-1', '/p/denied.pptx', { signal: expect.any(AbortSignal) });
  });

  it('shows the secrets-file message (not "corrupt") when the server asks for confirmation (428)', async () => {
    readFileBlob.mockImplementation(async () => new Response(null, { status: 428 }));
    render(<CodeEditorOfficePreview {...props('vault.xlsx', 'xlsx')} />);
    expect(await screen.findByText('officePreview.secretNotPreviewed')).toBeTruthy();
    expect(screen.getByText('common:secretFile.title')).toBeTruthy();
    expect(screen.queryByText('officePreview.failed')).toBeNull();
    // Fail closed: the preview never sends the confirmation itself.
    expect(readFileBlob).toHaveBeenCalledWith('proj-1', '/p/vault.xlsx', { signal: expect.any(AbortSignal) });
    expect(parseOfficeFile).not.toHaveBeenCalled();
  });

  it('C9: renders documents in a fully sandboxed frame; theme switches never refetch or reparse', async () => {
    readFileBlob.mockImplementation(async () => okResponse());
    parseOfficeFile.mockResolvedValue({ kind: 'document', document: sanitizeDocument({ bodyHtml: '<p>hi</p>', css: '' }) });
    const view = render(<CodeEditorOfficePreview {...props('report.docx', 'docx')} />);
    const frame = await screen.findByTitle('officePreview.documentFrameTitle');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain('<p>hi</p>');
    expect(frame.getAttribute('srcdoc')).toContain('#f1f1f3');
    expect(screen.getByRole('button', { name: 'binaryFile.download' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
    expect(parseOfficeFile).toHaveBeenCalledWith('docx', expect.any(Uint8Array), expect.any(AbortSignal));

    view.rerender(<CodeEditorOfficePreview {...props('report.docx', 'docx', true)} />);
    const themed = screen.getByTitle('officePreview.documentFrameTitle');
    expect(themed.getAttribute('srcdoc')).toContain('#1f1f23');
    expect(readFileBlob).toHaveBeenCalledTimes(1);
    expect(parseOfficeFile).toHaveBeenCalledTimes(1);
  });

  it('aborts the parse when the preview closes', async () => {
    readFileBlob.mockImplementation(async () => okResponse());
    let signal: AbortSignal | undefined;
    parseOfficeFile.mockImplementation((_format: string, _bytes: Uint8Array, received: AbortSignal) => {
      signal = received;
      return new Promise(() => {});
    });
    const view = render(<CodeEditorOfficePreview {...props('slow.xlsx', 'xlsx')} />);
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(signal?.aborted).toBe(false);
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('renders spreadsheets as a table with switchable sheet tabs and unique ids', async () => {
    readFileBlob.mockImplementation(async () => okResponse());
    parseOfficeFile.mockResolvedValue({
      kind: 'spreadsheet',
      workbook: { sheets: [sheetOf('One', 'alpha'), sheetOf('Two', 'beta', { rtl: true, truncated: true })] },
    });
    // Mounted one after the other: vitest can race two concurrent first-time
    // dynamic imports of the same mocked module.
    render(<CodeEditorOfficePreview {...props('book.xlsx', 'xlsx')} />);
    await screen.findByText('alpha');
    render(<CodeEditorOfficePreview {...props('copy.xlsx', 'xlsx')} />);
    await vi.waitFor(() => expect(screen.getAllByText('alpha')).toHaveLength(2));
    const [twoTab] = screen.getAllByRole('tab', { name: 'Two' });
    fireEvent.click(twoTab);
    expect(screen.getByText('beta')).toBeTruthy();
    expect(twoTab.getAttribute('aria-selected')).toBe('true');
    const panels = screen.getAllByRole('tabpanel');
    expect(new Set(panels.map((panel) => panel.id)).size).toBe(2);
    expect(panels[0].getAttribute('aria-labelledby')).toBe(twoTab.id);
    expect(screen.getAllByRole('table')[0].getAttribute('dir')).toBe('rtl');
    expect(screen.getByText('officePreview.truncated')).toBeTruthy();
  });

  it('moves between sheet tabs with arrow, Home and End keys', async () => {
    readFileBlob.mockImplementation(async () => okResponse());
    parseOfficeFile.mockResolvedValue({
      kind: 'spreadsheet',
      workbook: { sheets: [sheetOf('One', 'alpha'), sheetOf('Two', 'beta'), sheetOf('', 'gamma')] },
    });
    render(<CodeEditorOfficePreview {...props('book.xlsx', 'xlsx')} />);
    await screen.findByText('alpha');
    const selected = () => screen.getAllByRole('tab').findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
    fireEvent.keyDown(screen.getAllByRole('tab')[0], { key: 'ArrowRight' });
    expect(selected()).toBe(1);
    fireEvent.keyDown(screen.getAllByRole('tab')[1], { key: 'End' });
    expect(selected()).toBe(2);
    expect(screen.getByRole('tab', { name: 'officePreview.untitledSheet' })).toBeTruthy();
    fireEvent.keyDown(screen.getAllByRole('tab')[2], { key: 'ArrowLeft' });
    expect(selected()).toBe(1);
    fireEvent.keyDown(screen.getAllByRole('tab')[1], { key: 'Home' });
    expect(selected()).toBe(0);
    fireEvent.keyDown(screen.getAllByRole('tab')[0], { key: 'ArrowLeft' });
    expect(selected()).toBe(2);
  });

  it(`C11: shows ${ROWS_PER_PAGE} rows at first and more on request`, async () => {
    readFileBlob.mockImplementation(async () => okResponse());
    const rows = Array.from({ length: 450 }, (_, index) => [{ text: `r${index}`, numeric: false }]);
    parseOfficeFile.mockResolvedValue({ kind: 'spreadsheet', workbook: { sheets: [sheetOf('Big', '', { rows })] } });
    render(<CodeEditorOfficePreview {...props('big.xlsx', 'xlsx')} />);
    await screen.findByText('r0');
    expect(screen.queryByText(`r${ROWS_PER_PAGE}`)).toBeNull();
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'officePreview.showMoreRows' })); });
    expect(screen.getByText(`r${ROWS_PER_PAGE}`)).toBeTruthy();
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'officePreview.showMoreRows' })); });
    expect(screen.getByText('r449')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'officePreview.showMoreRows' })).toBeNull();
  });

  it('clips displayed cell text and bounds total displayed text per page', async () => {
    readFileBlob.mockImplementation(async () => okResponse());
    const huge = 'w'.repeat(32_767);
    const rows = Array.from({ length: 200 }, () => Array.from({ length: 100 }, () => ({ text: huge, numeric: false })));
    parseOfficeFile.mockResolvedValue({ kind: 'spreadsheet', workbook: { sheets: [sheetOf('Big', '', { rows, columnCount: 100 })] } });
    render(<CodeEditorOfficePreview {...props('huge.xlsx', 'xlsx')} />);
    const table = await screen.findByRole('table');
    const cells = Array.from(table.querySelectorAll('td'));
    expect(cells).toHaveLength(200 * 100);
    expect(Math.max(...cells.map((cell) => cell.textContent?.length ?? 0))).toBeLessThanOrEqual(MAX_DISPLAY_CELL_CHARS + 1);
    expect(table.textContent?.length ?? 0).toBeLessThanOrEqual(MAX_DISPLAY_PAGE_CHARS + 200 * 100 + 200 * 4 + 400);
    expect(cells[0].textContent?.endsWith('…')).toBe(true);
    expect(cells[0].hasAttribute('title')).toBe(false);
  }, 30_000);

  it('renders slide text per slide, and an empty template', async () => {
    readFileBlob.mockImplementation(async () => okResponse());
    parseOfficeFile.mockResolvedValueOnce({
      kind: 'slides',
      presentation: { slides: [{ number: 1, paragraphs: ['Title', 'Point'] }, { number: 2, paragraphs: [] }], truncated: false },
    });
    render(<CodeEditorOfficePreview {...props('deck.pptx', 'pptx')} />);
    expect(await screen.findByText('Title')).toBeTruthy();
    expect(screen.getByText('officePreview.emptySlide')).toBeTruthy();
    cleanup();
    parseOfficeFile.mockResolvedValueOnce({ kind: 'slides', presentation: { slides: [], truncated: false } });
    render(<CodeEditorOfficePreview {...props('theme.potx', 'pptx')} />);
    expect(await screen.findByText('officePreview.noSlides')).toBeTruthy();
  });

  it('renders OpenDocument text with headings', async () => {
    readFileBlob.mockImplementation(async () => okResponse());
    parseOfficeFile.mockResolvedValue({
      kind: 'text',
      text: { blocks: [{ text: 'العنوان', heading: 1 }, { text: 'فقرة', heading: null }], truncated: true },
    });
    render(<CodeEditorOfficePreview {...props('notes.odt', 'odt')} />);
    const heading = await screen.findByRole('heading', { name: 'العنوان' });
    expect(heading.getAttribute('aria-level')).toBe('4');
    expect(screen.getByText('فقرة')).toBeTruthy();
    expect(screen.getByText('officePreview.textTruncated')).toBeTruthy();
  });
});
