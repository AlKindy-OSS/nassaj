// Shared, format-neutral grid model for spreadsheet previews (XLSX and ODS).

export type SheetCell = {
  text: string;
  numeric: boolean;
  colSpan?: number;
  rowSpan?: number;
  /** Covered by a merged cell; not rendered. */
  covered?: boolean;
};

export type SheetData = {
  name: string;
  rows: (SheetCell | undefined)[][];
  columnCount: number;
  rtl: boolean;
  /** True when rows, columns, merges or cells past the preview limits were dropped. */
  truncated: boolean;
};

export type WorkbookData = { sheets: SheetData[] };

export const MAX_SHEETS = 50;
export const MAX_ROWS = 1000;
export const MAX_COLUMNS = 100;
/** Merged ranges honoured per sheet; the rest are ignored. */
export const MAX_MERGES = 5000;
/** Longest cell text shown (Excel's own per-cell limit); longer text is clipped. */
export const MAX_CELL_CHARS = 32_767;
/** Cells (values plus merge coverage) stored across the whole workbook. */
export const MAX_WORKBOOK_CELLS = 400_000;

/** Workbook-wide cell allowance shared by every sheet's builder. */
export class CellBudget {
  constructor(public remaining = MAX_WORKBOOK_CELLS) {}
}

/** Mutable builder that enforces the preview limits while cells are added. */
export class GridBuilder {
  private readonly rows: (SheetCell | undefined)[][] = [];
  private merges = 0;
  /** Cells visited by merges; real merges never overlap, so one grid's worth suffices. */
  private mergeArea = 0;
  truncated = false;

  constructor(private readonly budget: CellBudget = new CellBudget()) {}

  /** Stores a cell; returns false (and flags truncation) when out of bounds or budget. */
  set(row: number, col: number, cell: SheetCell): boolean {
    if (row < 0 || col < 0) return false;
    if (row >= MAX_ROWS || col >= MAX_COLUMNS) {
      if (cell.text !== '') this.truncated = true;
      return false;
    }
    if (cell.text.length > MAX_CELL_CHARS) {
      cell = { ...cell, text: cell.text.slice(0, MAX_CELL_CHARS) };
      this.truncated = true;
    }
    const cells = (this.rows[row] ??= []);
    if (cells[col] === undefined) {
      if (this.budget.remaining <= 0) {
        this.truncated = true;
        return false;
      }
      this.budget.remaining -= 1;
    }
    cells[col] = cell;
    return true;
  }

  get(row: number, col: number): SheetCell | undefined {
    return this.rows[row]?.[col];
  }

  /**
   * Marks a merged range: span on the anchor cell, covered elsewhere. Ranges
   * that start outside the preview, exceed the merge cap or would exhaust the
   * cell budget are ignored, so hostile merge lists cost bounded work.
   */
  merge(top: number, left: number, bottom: number, right: number): void {
    if (top < 0 || left < 0 || top >= MAX_ROWS || left >= MAX_COLUMNS || bottom < top || right < left) return;
    if (this.merges >= MAX_MERGES) {
      this.truncated = true;
      return;
    }
    this.merges += 1;
    const lastRow = Math.min(bottom, MAX_ROWS - 1);
    const lastCol = Math.min(right, MAX_COLUMNS - 1);
    const area = (lastRow - top + 1) * (lastCol - left + 1);
    if (area > this.budget.remaining || this.mergeArea + area > MAX_ROWS * MAX_COLUMNS) {
      this.truncated = true;
      return;
    }
    this.mergeArea += area;
    const anchor = this.get(top, left) ?? { text: '', numeric: false };
    for (let row = top; row <= lastRow; row += 1) {
      for (let col = left; col <= lastCol; col += 1) {
        if (row !== top || col !== left) this.set(row, col, { text: '', numeric: false, covered: true });
      }
    }
    this.set(top, left, { ...anchor, rowSpan: lastRow - top + 1, colSpan: lastCol - left + 1 });
  }

  /** Produces the final sheet, trimming trailing empty rows and columns. */
  build(name: string, rtl: boolean): SheetData {
    let lastRow = -1;
    let lastCol = -1;
    this.rows.forEach((cells, rowIndex) => {
      cells?.forEach((cell, colIndex) => {
        if (cell && (cell.text !== '' || cell.colSpan || cell.rowSpan)) {
          lastRow = Math.max(lastRow, rowIndex + (cell.rowSpan ?? 1) - 1);
          lastCol = Math.max(lastCol, colIndex + (cell.colSpan ?? 1) - 1);
        }
      });
    });
    const rows = Array.from({ length: lastRow + 1 }, (_, rowIndex) => {
      const cells = this.rows[rowIndex] ?? [];
      return Array.from({ length: lastCol + 1 }, (__, colIndex) => cells[colIndex]);
    });
    return { name, rows, columnCount: lastCol + 1, rtl, truncated: this.truncated };
  }
}

/** Converts a zero-based column index to its spreadsheet letters (0 → A). */
export function columnLabel(index: number): string {
  let label = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    label = String.fromCharCode(65 + ((n - 1) % 26)) + label;
  }
  return label;
}

/** Parses an A1-style reference into zero-based indices. */
export function parseCellRef(ref: string): { row: number; col: number } | null {
  const match = /^\$?([A-Z]{1,3})\$?(\d{1,7})$/i.exec(ref.trim());
  if (!match) return null;
  let col = 0;
  for (const char of match[1].toUpperCase()) col = col * 26 + (char.charCodeAt(0) - 64);
  return { row: Number(match[2]) - 1, col: col - 1 };
}
