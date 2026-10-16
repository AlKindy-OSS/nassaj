import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';

import { nextSortState, sortRowOrder, type SortState } from './tableSort';

/** Above this many body rows the table renders as-is, without sort controls. */
export const MAX_SORTABLE_ROWS = 2000;

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
};

function elements(node: HastNode | undefined, tagName: string): HastNode[] {
  return (node?.children ?? []).filter((c) => c.type === 'element' && c.tagName === tagName);
}

function nodeText(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(nodeText).join('');
}

type SortContextValue = {
  headerCells: HastNode[];
  state: SortState;
  onSort: (column: number) => void;
};

const SortContext = createContext<SortContextValue | null>(null);

type TableProps = { node?: HastNode; children?: React.ReactNode };

/**
 * `components.table` for chat Markdown: GFM tables get 3-state column sorting
 * (ascending → descending → original). Sorting reorders the already-rendered
 * row elements, so cell content (links, code, emphasis) is untouched.
 */
export function SortableTable({ node, children }: TableProps) {
  const { i18n } = useTranslation();
  // Optional chaining: test doubles of react-i18next often omit `i18n`.
  const locale = i18n?.language ?? '';
  const [state, setState] = useState<SortState>(null);

  const model = useMemo(() => {
    const headerRow = elements(elements(node, 'thead')[0], 'tr')[0];
    const rows = elements(elements(node, 'tbody')[0], 'tr');
    return { headerCells: elements(headerRow, 'th'), rows };
  }, [node]);

  const sortable = model.headerCells.length > 0 && model.rows.length > 1 && model.rows.length <= MAX_SORTABLE_ROWS;

  const order = useMemo(() => {
    if (!sortable || !state) return null;
    const cells = model.rows.map((row) => {
      const cell = row.children?.filter((c) => c.type === 'element')[state.column];
      return cell ? nodeText(cell) : '';
    });
    return sortRowOrder(cells, state, locale);
  }, [model, sortable, state, locale]);

  const onSort = useCallback((column: number) => setState((s) => nextSortState(s, column)), []);
  const context = useMemo(
    () => (sortable ? { headerCells: model.headerCells, state, onSort } : null),
    [sortable, model.headerCells, state, onSort],
  );

  return (
    <SortContext.Provider value={context}>
      <div className="my-2 overflow-x-auto">
        <table className="min-w-full border-collapse border border-border">
          {reorderBody(children, order, model.rows.length)}
        </table>
      </div>
    </SortContext.Provider>
  );
}

/**
 * Applies `order` to the <tbody> row elements; leaves the table alone on any
 * shape mismatch. Always maps (even unsorted) so child keys never change shape
 * between states — otherwise React remounts the header and the focused sort
 * button loses focus.
 */
function reorderBody(children: React.ReactNode, order: number[] | null, expectedRows: number): React.ReactNode {
  return React.Children.map(children, (child) => {
    if (!order || !React.isValidElement(child) || child.type !== 'tbody') return child;
    const rows = React.Children.toArray((child.props as { children?: React.ReactNode }).children)
      .filter(React.isValidElement);
    if (rows.length !== expectedRows) return child;
    return React.cloneElement(child, undefined, order.map((i) => rows[i]));
  });
}

type HeaderCellProps = {
  node?: HastNode;
  children?: React.ReactNode;
  className?: string;
  dir?: 'ltr' | 'rtl';
  style?: React.CSSProperties;
};

/**
 * Header cell: when its table is sortable, the content becomes a button and
 * the cell carries `aria-sort`. The column is found by identity of the hast
 * node, which react-markdown passes unchanged to both table and cell.
 */
export function SortableHeaderCell({ node, children, className, dir, style }: HeaderCellProps) {
  const { t } = useTranslation('chat');
  const ctx = useContext(SortContext);
  const column = ctx && node ? ctx.headerCells.indexOf(node) : -1;
  if (!ctx || column < 0) {
    return <th className={className} dir={dir} style={style}>{children}</th>;
  }
  const direction = ctx.state?.column === column ? ctx.state.direction : null;
  const next = nextSortState(ctx.state, column);
  const hint = !next
    ? t('table.sortNone', { defaultValue: 'Unsorted' })
    : next.direction === 'ascending'
      ? t('table.sortAscending', { defaultValue: 'Sort ascending' })
      : t('table.sortDescending', { defaultValue: 'Sort descending' });
  const Icon = direction === 'ascending' ? ArrowUp : direction === 'descending' ? ArrowDown : ArrowUpDown;
  return (
    <th className={className} dir={dir} style={style} aria-sort={direction ?? 'none'}>
      <button
        type="button"
        onClick={() => ctx.onSort(column)}
        title={hint}
        className="inline-flex w-full items-center justify-between gap-1.5 text-start font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span>{children}</span>
        <Icon aria-hidden="true" className={`h-3.5 w-3.5 flex-shrink-0 ${direction ? '' : 'opacity-40'}`} />
      </button>
    </th>
  );
}
