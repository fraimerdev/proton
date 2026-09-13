import type { ReactElement, ReactNode } from 'react';
import { Button, cx } from './controls.tsx';
import { EmptyState, LoadingArea } from './feedback.tsx';
import { Icon, type IconName } from './icon.tsx';

export interface Column<Row> {
  id: string;
  header: string;
  /** Sortable columns pass the field name the query understands. */
  sortField?: string | undefined;
  align?: 'left' | 'right' | undefined;
  width?: number | string | undefined;
  primary?: boolean | undefined;
  cell: (row: Row) => ReactNode;
}

export interface SortState {
  field: string;
  direction: 'asc' | 'desc';
}

interface DataTableProps<Row> {
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  onRowClick?: ((row: Row) => void) | undefined;
  sort?: SortState | undefined;
  onSortChange?: ((sort: SortState) => void) | undefined;
  loading?: boolean | undefined;
  loadingLabel?: string | undefined;
  empty?: { icon?: IconName | undefined; title: string; body?: ReactNode } | undefined;
  footer?: ReactNode;
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  onRowClick,
  sort,
  onSortChange,
  loading = false,
  loadingLabel,
  empty,
  footer,
}: DataTableProps<Row>): ReactElement {
  const toggle = (field: string): void => {
    if (!onSortChange) return;

    onSortChange(
      sort?.field === field
        ? { field, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
        : { field, direction: 'desc' },
    );
  };

  return (
    <div className="table-wrap">
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              {columns.map((column) => {
                const sortable = column.sortField !== undefined && onSortChange !== undefined;
                // Held in a local so the narrowing survives into the JSX below.
                const active = sort !== undefined && sort.field === column.sortField ? sort : null;

                return (
                  <th
                    key={column.id}
                    style={{ width: column.width }}
                    className={cx(column.align === 'right' && 'numeric', sortable && 'sortable')}
                    aria-sort={
                      active ? (active.direction === 'asc' ? 'ascending' : 'descending') : undefined
                    }
                    onClick={sortable ? () => toggle(column.sortField as string) : undefined}
                  >
                    {column.header}
                    {active ? (
                      <Icon
                        name={active.direction === 'asc' ? 'sort-ascending' : 'sort-descending'}
                        size={12}
                        weight="fill"
                        className="sort-icon"
                      />
                    ) : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              <tr className="table-loading">
                <td colSpan={columns.length} className="table-loading-cell">
                  <LoadingArea label={loadingLabel} minHeight={220} />
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={rowKey(row)}
                  className={cx(onRowClick && 'clickable')}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {columns.map((column) => (
                    <td
                      key={column.id}
                      className={cx(
                        column.align === 'right' && 'numeric',
                        column.primary === true && 'primary-cell',
                      )}
                    >
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {!loading && rows.length === 0 && empty ? (
        <EmptyState icon={empty.icon} title={empty.title}>
          {empty.body}
        </EmptyState>
      ) : null}

      {footer !== undefined ? (
        <div
          className={cx('table-foot', loading && rows.length === 0 && 'table-foot-waiting')}
          inert={loading && rows.length === 0}
        >
          {footer}
        </div>
      ) : null}
    </div>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  noun = 'rows',
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  noun?: string | undefined;
}): ReactElement {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <>
      <span>{total === 0 ? `No ${noun}` : `${from}–${to} of ${total} ${noun}`}</span>
      <span className="table-foot-spacer" />
      <Button
        tone="ghost"
        size="sm"
        icon="caret-left"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        Previous
      </Button>
      <span>
        Page {page} of {pages}
      </span>
      <Button
        tone="ghost"
        size="sm"
        trailingIcon="caret-right"
        disabled={page >= pages}
        onClick={() => onPageChange(page + 1)}
      >
        Next
      </Button>
    </>
  );
}
