import { createCheckpoint } from './cancellation';
import {
  CellBudget,
  GridBuilder,
  MAX_CELL_CHARS,
  MAX_COLUMNS,
  MAX_MERGES,
  MAX_ROWS,
  MAX_SHEETS,
  type SheetData,
  type WorkbookData,
} from './sheetGrid';
import { OfficeParseError, attrByName, childrenByName, descendantsByName, type OfficePackage } from './zipXml';

const NUMERIC_TYPES = new Set(['float', 'percentage', 'currency']);
const ROW_CONTAINERS = new Set(['table-header-rows', 'table-row-group', 'table-rows']);

/** Positive repeat/span count from an ODF attribute (default 1). */
const repeatCount = (element: Element, name: string): number => {
  const value = Number(attrByName(element, name) ?? 1);
  return Number.isInteger(value) && value > 0 ? value : 1;
};

/** Table rows in document order, descending into row groups without recursion. */
function* tableRows(table: Element): Generator<Element> {
  const stack: Element[] = [];
  let next: Element | null = table.firstElementChild;
  while (next || stack.length > 0) {
    if (!next) {
      next = stack.pop()?.nextElementSibling ?? null;
      continue;
    }
    if (next.localName === 'table-row') {
      yield next;
      next = next.nextElementSibling;
    } else if (ROW_CONTAINERS.has(next.localName)) {
      stack.push(next);
      next = next.firstElementChild;
    } else {
      next = next.nextElementSibling;
    }
  }
}

/** The text an ODS cell displays: its paragraphs joined by line breaks, clipped. */
function cellDisplayText(cell: Element): string {
  let text = '';
  for (const p of childrenByName(cell, 'p')) {
    text += (text === '' ? '' : '\n') + (p.textContent ?? '');
    if (text.length > MAX_CELL_CHARS) return text;
  }
  return text;
}

/** Junk (non-cell) siblings tolerated per row before the rest is ignored. */
const MAX_ROW_SIBLINGS = MAX_COLUMNS * 20;

type RowCell = { col: number; repeat: number; text: string; numeric: boolean; rowSpan: number; colSpan: number };
type RowModel = { cells: RowCell[]; hasText: boolean; clipped: boolean };

/**
 * Reads one `<table-row>` once: the cells it contributes within the column
 * limit. Repeated rows reuse this model instead of re-reading the XML.
 */
function readRow(row: Element): RowModel {
  const cells: RowCell[] = [];
  let col = 0;
  let visited = 0;
  let clipped = false;
  for (let cell = row.firstElementChild; cell && col < MAX_COLUMNS; cell = cell.nextElementSibling) {
    if ((visited += 1) > MAX_ROW_SIBLINGS) {
      clipped = true;
      break;
    }
    if (cell.localName !== 'table-cell' && cell.localName !== 'covered-table-cell') continue;
    const repeat = repeatCount(cell, 'number-columns-repeated');
    const text = cell.localName === 'table-cell' ? cellDisplayText(cell) : '';
    const numeric = NUMERIC_TYPES.has(attrByName(cell, 'value-type') ?? '');
    cells.push({ col, repeat, text, numeric, rowSpan: repeatCount(cell, 'number-rows-spanned'), colSpan: repeatCount(cell, 'number-columns-spanned') });
    col += repeat;
  }
  return { cells, hasText: cells.some((cell) => cell.text !== ''), clipped };
}

type MergeCounter = { count: number };

function addRowCells(grid: GridBuilder, model: RowModel, rowIndex: number, merges: MergeCounter): void {
  for (const { col, repeat, text, numeric, rowSpan, colSpan } of model.cells) {
    if (text !== '') {
      const copies = Math.min(repeat, MAX_COLUMNS - col);
      for (let offset = 0; offset < copies; offset += 1) grid.set(rowIndex, col + offset, { text, numeric });
      if (repeat > copies) grid.truncated = true;
    }
    if (rowSpan > 1 || colSpan > 1) {
      merges.count += 1;
      if (merges.count <= MAX_MERGES) grid.merge(rowIndex, col, rowIndex + rowSpan - 1, col + colSpan - 1);
      else grid.truncated = true;
    }
  }
}

async function parseTable(table: Element, rtlStyles: Set<string>, budget: CellBudget, checkpoint: () => Promise<void>): Promise<SheetData> {
  const grid = new GridBuilder(budget);
  const merges: MergeCounter = { count: 0 };
  let rowIndex = 0;
  for (const row of tableRows(table)) {
    await checkpoint();
    const model = readRow(row);
    if (model.clipped) grid.truncated = true;
    if (rowIndex >= MAX_ROWS) {
      if (model.hasText) grid.truncated = true;
      break;
    }
    const repeat = repeatCount(row, 'number-rows-repeated');
    // Huge empty repeats (a sheet padded to 1M rows) are skipped, not expanded.
    const copies = model.hasText ? Math.min(repeat, MAX_ROWS - rowIndex) : 0;
    for (let offset = 0; offset < copies; offset += 1) addRowCells(grid, model, rowIndex + offset, merges);
    if (model.hasText && repeat > copies) grid.truncated = true;
    rowIndex += repeat;
  }
  const rtl = rtlStyles.has(attrByName(table, 'style-name') ?? '');
  return grid.build(attrByName(table, 'name') ?? '', rtl);
}

/**
 * Names of table styles laid out right-to-left. LibreOffice records a sheet's
 * direction as `style:writing-mode="rl-tb"` on the table style's properties.
 */
function rightToLeftTableStyles(content: Document): Set<string> {
  const names = new Set<string>();
  for (const style of descendantsByName(content, 'style')) {
    if (attrByName(style, 'family') !== 'table') continue;
    const properties = childrenByName(style, 'table-properties')[0];
    const mode = properties ? attrByName(properties, 'writing-mode') ?? '' : '';
    const name = attrByName(style, 'name');
    if (name && mode.startsWith('rl')) names.add(name);
  }
  return names;
}

/** Parses an ODS package into a read-only workbook preview model. */
export async function parseOds(pkg: OfficePackage, signal?: AbortSignal): Promise<WorkbookData> {
  const checkpoint = createCheckpoint(signal);
  const content = await pkg.readXml('content.xml');
  const spreadsheet = content ? descendantsByName(content, 'spreadsheet')[0] : undefined;
  if (!content || !spreadsheet) throw new OfficeParseError('Missing spreadsheet body');
  const rtlStyles = rightToLeftTableStyles(content);
  const budget = new CellBudget();
  const sheets: SheetData[] = [];
  for (const table of childrenByName(spreadsheet, 'table').slice(0, MAX_SHEETS)) {
    await checkpoint();
    sheets.push(await parseTable(table, rtlStyles, budget, checkpoint));
  }
  if (sheets.length === 0) throw new OfficeParseError('Spreadsheet has no tables');
  return { sheets };
}
