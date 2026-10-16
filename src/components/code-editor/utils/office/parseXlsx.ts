import { createCheckpoint } from './cancellation';
import {
  CellBudget,
  GridBuilder,
  MAX_CELL_CHARS,
  MAX_COLUMNS,
  MAX_MERGES,
  MAX_ROWS,
  MAX_SHEETS,
  parseCellRef,
  type SheetData,
  type WorkbookData,
} from './sheetGrid';
import {
  OfficeParseError,
  childrenByName,
  descendantsByName,
  elementsInOrder,
  forEachDescendant,
  relationshipId,
  type OfficePackage,
} from './zipXml';

// Built-in number formats that represent dates or times (ECMA-376 §18.8.30).
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const MS_PER_DAY = 86_400_000;
const EPOCH_1900 = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);

type CellContext = { sharedStrings: string[]; dateStyles: Set<number>; date1904: boolean };

/** True when a custom number format code renders a date or time. */
export function isDateFormatCode(code: string): boolean {
  const stripped = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '');
  return /[dmyhs]/i.test(stripped);
}

/** Formats a date serial as ISO date, date-time, or time. */
export function formatDateSerial(serial: number, date1904: boolean): string {
  const epoch = date1904 ? EPOCH_1904 : EPOCH_1900;
  const date = new Date(epoch + Math.round(serial * MS_PER_DAY));
  if (Number.isNaN(date.getTime())) return String(serial);
  const iso = date.toISOString();
  if (serial < 1 && serial >= 0) return iso.slice(11, 19);
  return Number.isInteger(serial) ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** Trims binary floating-point noise (0.1+0.2) without losing precision. */
const formatNumber = (raw: string): string => {
  const value = Number(raw);
  if (!Number.isFinite(value)) return raw;
  return Number.isInteger(value) ? String(value) : String(Number.parseFloat(value.toPrecision(15)));
};

/** Concatenates the visible runs of a rich-text item, skipping phonetic hints; clipped. */
function richText(item: Element): string {
  let text = '';
  for (const t of descendantsByName(item, 't')) {
    if (t.parentElement?.localName === 'rPh') continue;
    text += t.textContent ?? '';
    if (text.length > MAX_CELL_CHARS) break;
  }
  return text;
}

async function readSharedStrings(pkg: OfficePackage): Promise<string[]> {
  const doc = await pkg.readXml('xl/sharedStrings.xml');
  return doc ? descendantsByName(doc, 'si').map(richText) : [];
}

async function readDateStyles(pkg: OfficePackage): Promise<Set<number>> {
  const doc = await pkg.readXml('xl/styles.xml');
  const dateStyles = new Set<number>();
  if (!doc) return dateStyles;
  const customDate = new Set<number>();
  for (const fmt of descendantsByName(doc, 'numFmt')) {
    if (isDateFormatCode(fmt.getAttribute('formatCode') ?? '')) customDate.add(Number(fmt.getAttribute('numFmtId')));
  }
  const cellXfs = descendantsByName(doc, 'cellXfs')[0];
  childrenByName(cellXfs ?? doc.documentElement, 'xf').forEach((xf, index) => {
    const id = Number(xf.getAttribute('numFmtId') ?? 0);
    if (BUILTIN_DATE_FORMATS.has(id) || customDate.has(id)) dateStyles.add(index);
  });
  return dateStyles;
}

/** Converts one `<c>` element to its displayed text. */
export function cellText(cell: Element, context: CellContext): { text: string; numeric: boolean } {
  const type = cell.getAttribute('t') ?? 'n';
  const raw = childrenByName(cell, 'v')[0]?.textContent ?? '';
  switch (type) {
    case 's':
      return { text: context.sharedStrings[Number(raw)] ?? '', numeric: false };
    case 'inlineStr': {
      const inline = childrenByName(cell, 'is')[0];
      return { text: inline ? richText(inline) : '', numeric: false };
    }
    case 'b':
      return { text: raw === '1' ? 'TRUE' : 'FALSE', numeric: false };
    case 'str':
    case 'e':
    case 'd':
      return { text: raw, numeric: false };
    default: {
      if (raw === '') return { text: '', numeric: false };
      const style = Number(cell.getAttribute('s') ?? -1);
      const value = Number(raw);
      if (context.dateStyles.has(style) && Number.isFinite(value)) {
        return { text: formatDateSerial(value, context.date1904), numeric: true };
      }
      return { text: formatNumber(raw), numeric: true };
    }
  }
}

/** True when a `<row>` holds any cell with a value (used to flag truncation). */
const rowHasValues = (row: Element): boolean =>
  childrenByName(row, 'c').some((cell) => childrenByName(cell, 'v').length > 0 || childrenByName(cell, 'is').length > 0);

function addRowCells(grid: GridBuilder, row: Element, rowIndex: number, context: CellContext): void {
  let colIndex = -1;
  for (let cell = row.firstElementChild; cell; cell = cell.nextElementSibling) {
    if (cell.localName !== 'c') continue;
    const ref = parseCellRef(cell.getAttribute('r') ?? '');
    colIndex = ref ? ref.col : colIndex + 1;
    if (colIndex >= MAX_COLUMNS) {
      if (cellText(cell, context).text !== '') grid.truncated = true;
      return;
    }
    const value = cellText(cell, context);
    if (value.text !== '') grid.set(rowIndex, colIndex, value);
  }
}

async function parseWorksheet(
  doc: Document,
  name: string,
  context: CellContext,
  budget: CellBudget,
  checkpoint: () => Promise<void>,
): Promise<SheetData> {
  const grid = new GridBuilder(budget);
  const rtl = descendantsByName(doc, 'sheetView').some((view) => ['1', 'true'].includes(view.getAttribute('rightToLeft') ?? ''));
  let rowIndex = -1;
  for (const row of elementsInOrder(doc)) {
    if (row.localName !== 'row') continue;
    await checkpoint();
    const declaredRow = Number(row.getAttribute('r'));
    rowIndex = Number.isInteger(declaredRow) && declaredRow > 0 ? declaredRow - 1 : rowIndex + 1;
    if (rowIndex >= MAX_ROWS) {
      // Rows are stored in ascending order: nothing after this one is shown.
      if (rowHasValues(row)) grid.truncated = true;
      break;
    }
    addRowCells(grid, row, rowIndex, context);
  }
  let merges = 0;
  forEachDescendant(doc, 'mergeCell', (mergeCell) => {
    if ((merges += 1) > MAX_MERGES) {
      grid.truncated = true;
      return false;
    }
    const [from, to] = (mergeCell.getAttribute('ref') ?? '').split(':').map(parseCellRef);
    if (from && to) grid.merge(from.row, from.col, to.row, to.col);
    return true;
  });
  return grid.build(name, rtl);
}

/** Parses an XLSX-family package (xlsx/xlsm/xltx) into a read-only workbook model. */
export async function parseXlsx(pkg: OfficePackage, signal?: AbortSignal): Promise<WorkbookData> {
  const checkpoint = createCheckpoint(signal);
  const workbook = await pkg.readXml('xl/workbook.xml');
  if (!workbook) throw new OfficeParseError('Missing xl/workbook.xml');
  const relationships = await pkg.readRelationships('xl/_rels/workbook.xml.rels', 'xl');
  const workbookPr = descendantsByName(workbook, 'workbookPr')[0];
  const context: CellContext = {
    sharedStrings: await readSharedStrings(pkg),
    dateStyles: await readDateStyles(pkg),
    date1904: ['1', 'true'].includes(workbookPr?.getAttribute('date1904') ?? ''),
  };
  const visibleSheets = descendantsByName(workbook, 'sheet')
    .filter((sheet) => !['hidden', 'veryHidden'].includes(sheet.getAttribute('state') ?? ''))
    .slice(0, MAX_SHEETS);
  const budget = new CellBudget();
  const sheets: SheetData[] = [];
  for (const sheet of visibleSheets) {
    await checkpoint();
    const target = relationships.get(relationshipId(sheet));
    const doc = target ? await pkg.readXml(target) : null;
    if (doc) sheets.push(await parseWorksheet(doc, sheet.getAttribute('name') ?? '', context, budget, checkpoint));
  }
  if (sheets.length === 0) throw new OfficeParseError('Workbook has no readable sheets');
  return { sheets };
}
