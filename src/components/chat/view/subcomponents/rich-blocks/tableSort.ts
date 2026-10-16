/**
 * Pure sorting rules for chat Markdown tables.
 */

export type SortDirection = 'ascending' | 'descending';
export type SortState = { column: number; direction: SortDirection } | null;

const DIGIT_MAP: Record<string, string> = {};
'٠١٢٣٤٥٦٧٨٩'.split('').forEach((d, i) => { DIGIT_MAP[d] = String(i); });
'۰۱۲۳۴۵۶۷۸۹'.split('').forEach((d, i) => { DIGIT_MAP[d] = String(i); });

const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * Reads a table cell as a number, or `null` when it is not one.
 *
 * Accepts Arabic-Indic and Persian digits, the Arabic decimal (٫) and thousands
 * (٬) separators, ASCII thousands commas, a leading sign (incl. U+2212) and a
 * trailing or leading percent sign (٪ or %). Anything else is text.
 */
export function parseCellNumber(text: string): number | null {
  let s = text.trim();
  if (!s) return null;
  s = s.replace(/[٠-٩۰-۹]/g, (d) => DIGIT_MAP[d]);
  s = s.replace(/[‎‏؜\s]/g, '').replace(/−/g, '-');
  s = s.replace(/^[%٪]|[%٪]$/g, '');
  s = s.replace(/٫/g, '.').replace(/[٬,](?=\d{3}(?:\D|$))/g, '');
  if (!NUMBER_RE.test(s)) return null;
  const value = Number(s);
  return Number.isFinite(value) ? value : null;
}

/** A column is numeric when every non-empty cell parses as a number. */
export function isNumericColumn(cells: string[]): boolean {
  let seen = 0;
  for (const cell of cells) {
    if (!cell.trim()) continue;
    if (parseCellNumber(cell) === null) return false;
    seen += 1;
  }
  return seen > 0;
}

/**
 * Returns row indices in display order. Stable; empty cells always go last;
 * `null` state returns the original order.
 */
export function sortRowOrder(columnCells: string[], state: SortState, locale: string): number[] {
  const order = columnCells.map((_, i) => i);
  if (!state) return order;
  const sign = state.direction === 'ascending' ? 1 : -1;
  const numeric = isNumericColumn(columnCells);
  let collator: Intl.Collator;
  try {
    collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  } catch {
    collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  }
  const keys = columnCells.map((c) => (numeric ? parseCellNumber(c) : c.trim()));
  return order.sort((a, b) => {
    const ka = keys[a];
    const kb = keys[b];
    const emptyA = ka === null || ka === '';
    const emptyB = kb === null || kb === '';
    if (emptyA || emptyB) return emptyA === emptyB ? a - b : emptyA ? 1 : -1;
    const cmp = numeric ? (ka as number) - (kb as number) : collator.compare(ka as string, kb as string);
    return cmp !== 0 ? cmp * sign : a - b;
  });
}

/** asc → desc → original → asc … for one column; a new column starts at asc. */
export function nextSortState(current: SortState, column: number): SortState {
  if (!current || current.column !== column) return { column, direction: 'ascending' };
  if (current.direction === 'ascending') return { column, direction: 'descending' };
  return null;
}
