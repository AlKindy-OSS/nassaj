import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { MAX_COLUMNS, MAX_ROWS, columnLabel, type SheetData, type WorkbookData } from '../../../utils/office/sheetGrid';

// Row numbers stay visible while scrolling sideways. Inline logical inset on
// purpose: tailwindcss-rtl's start-* sets both sides inside dir=ltr islands.
const STICKY_ROW_HEADER = { insetInlineStart: 0 } as const;
const HEADER_CELL = 'border border-border bg-muted px-2 py-1 text-xs font-medium text-muted-foreground';
/** Rows rendered at first (and added per "show more"), keeping phones responsive. */
export const ROWS_PER_PAGE = 200;
/** Longest text shown in one cell; the rest is elided (layout cost grows with text). */
export const MAX_DISPLAY_CELL_CHARS = 1000;
/** Text rendered per page of rows; cells past it show only an ellipsis. */
export const MAX_DISPLAY_PAGE_CHARS = 200_000;

/** Display strings for the shown rows, clipped per cell and against a page budget. */
function displayTexts(rows: SheetData['rows']): string[][] {
  let remaining = MAX_DISPLAY_PAGE_CHARS;
  return rows.map((cells) => cells.map((cell) => {
    const text = cell?.text ?? '';
    if (text === '') return '';
    const allowed = Math.min(MAX_DISPLAY_CELL_CHARS, Math.max(remaining, 0));
    const shown = text.length > allowed ? `${text.slice(0, allowed)}…` : text;
    remaining -= Math.min(text.length, allowed);
    return shown;
  }));
}

function SheetTable({ sheet }: { sheet: SheetData }) {
  const { t } = useTranslation('codeEditor');
  const [visibleRows, setVisibleRows] = useState(ROWS_PER_PAGE);
  if (sheet.rows.length === 0) {
    return <p className="p-6 text-center text-sm text-muted-foreground">{t('officePreview.emptySheet')}</p>;
  }
  const columns = Array.from({ length: sheet.columnCount }, (_, index) => index);
  const shownRows = Math.min(visibleRows, sheet.rows.length);
  // Merged cells spanning past the last shown row are clipped to it.
  const clipSpan = (rowIndex: number, span?: number) => (span ? Math.min(span, shownRows - rowIndex) : undefined);
  const texts = displayTexts(sheet.rows.slice(0, shownRows));
  return (
    <>
    <table dir={sheet.rtl ? 'rtl' : 'ltr'} className="border-collapse text-sm text-foreground">
      <thead className="sticky top-0 z-10">
        <tr>
          <th scope="col" className={`${HEADER_CELL} sticky z-20`} style={STICKY_ROW_HEADER}>
            <span className="sr-only">#</span>
          </th>
          {columns.map((col) => (
            <th key={col} scope="col" className={`${HEADER_CELL} min-w-16`}>{columnLabel(col)}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sheet.rows.slice(0, shownRows).map((cells, rowIndex) => (
          // Rows are positional and never reorder, so the index is a stable key.
          <tr key={rowIndex}>
            <th scope="row" className={`${HEADER_CELL} sticky z-[5] text-end tabular-nums`} style={STICKY_ROW_HEADER}>
              {rowIndex + 1}
            </th>
            {cells.map((cell, colIndex) => (cell?.covered ? null : (
              <td
                key={colIndex}
                rowSpan={clipSpan(rowIndex, cell?.rowSpan)}
                colSpan={cell?.colSpan}
                className={`max-w-sm whitespace-pre-wrap break-words border border-border bg-background px-2 py-1 align-top [unicode-bidi:plaintext] ${
                  cell?.numeric ? 'text-end tabular-nums' : 'text-start'
                }`}
              >
                {texts[rowIndex][colIndex]}
              </td>
            )))}
          </tr>
        ))}
      </tbody>
    </table>
    {shownRows < sheet.rows.length && (
      <div className="sticky flex items-center gap-3 p-3 text-xs text-muted-foreground" style={STICKY_ROW_HEADER}>
        <span>{t('officePreview.rowsShown', { shown: shownRows, total: sheet.rows.length })}</span>
        <button
          type="button"
          onClick={() => setVisibleRows((count) => count + ROWS_PER_PAGE)}
          className="min-h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {t('officePreview.showMoreRows')}
        </button>
      </div>
    )}
    </>
  );
}

/** Read-only spreadsheet preview: one table per sheet with sheet tabs. */
export default function OfficeSpreadsheetView({ workbook }: { workbook: WorkbookData }) {
  const { t } = useTranslation('codeEditor');
  const [active, setActive] = useState(0);
  const idPrefix = useId();
  const panelId = `${idPrefix}-panel`;
  const tabId = (index: number) => `${idPrefix}-tab-${index}`;
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const sheet = workbook.sheets[Math.min(active, workbook.sheets.length - 1)];

  const selectTab = (index: number) => {
    const next = (index + workbook.sheets.length) % workbook.sheets.length;
    setActive(next);
    tabRefs.current[next]?.focus();
  };

  // Arrow keys follow visual order, which flips in right-to-left layouts.
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[event.key];
    if (step !== undefined) selectTab(index + step);
    else if (event.key === 'Home') selectTab(0);
    else if (event.key === 'End') selectTab(workbook.sheets.length - 1);
    else return;
    event.preventDefault();
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {sheet.truncated && (
        <p className="border-b border-border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
          {t('officePreview.truncated', { rows: MAX_ROWS, columns: MAX_COLUMNS })}
        </p>
      )}
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(Math.min(active, workbook.sheets.length - 1))}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        {/* Keyed per sheet so "show more" restarts for each sheet. */}
        <SheetTable key={active} sheet={sheet} />
      </div>
      <div
        role="tablist"
        aria-label={t('officePreview.sheetTabs')}
        className="flex shrink-0 gap-1 overflow-x-auto border-t border-border bg-muted/40 px-2 py-1"
      >
        {workbook.sheets.map((item, index) => (
          <button
            // Sheet names may repeat across odd files; position is the identity.
            key={index}
            ref={(element) => { tabRefs.current[index] = element; }}
            id={tabId(index)}
            type="button"
            role="tab"
            aria-selected={index === active}
            aria-controls={panelId}
            tabIndex={index === active ? 0 : -1}
            onClick={() => setActive(index)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
            className={`min-h-9 shrink-0 whitespace-nowrap rounded-md px-3 text-sm [unicode-bidi:plaintext] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${
              index === active
                ? 'bg-background font-medium text-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
          >
            {item.name || t('officePreview.untitledSheet', { number: index + 1 })}
          </button>
        ))}
      </div>
    </div>
  );
}
