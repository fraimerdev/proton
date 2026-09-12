import type { ColumnDef, ColumnHelper, ReactTable, Row, RowData } from '@tanstack/react-table';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { type ReactElement, type ReactNode, type RefObject, useMemo, useRef } from 'react';
import { Icon } from '../shell/icon.tsx';

const features = tableFeatures({});

// A first-paint estimate of .table-scroll's height, not a cap: the sheet sizes the scroller off the
// window now. Overshooting makes the server render rows the client then throws away, and the
// virtualiser has no way to measure the element before that first paint.
const VIEWPORT_PX = 640;

// 8px of padding on 13px/1.4 text. The ledger was configured at 56 against a 44px CSS row, so a
// 1440px display showed nine cases and then several hundred pixels of nothing.
export const DATA_ROW_HEIGHT = 36;

// Three, because the shape is the point: fewer reads as a stalled table, more as a full one.
const SKELETON_ROWS = 3;

export type DataTableFeatures = typeof features;

export function dataColumnHelper<TData extends RowData>(): ColumnHelper<DataTableFeatures, TData> {
  return createColumnHelper<DataTableFeatures, TData>();
}

export type SortDirection = 'asc' | 'desc';

export interface TableSort<TField extends string> {
  fields: Readonly<Record<string, TField>>;
  field: TField;
  direction: SortDirection;
  onSort: (patch: { sort: TField; direction: SortDirection }) => void;
}

export type RowAttributes<TData> = (row: TData) => Record<string, string | number>;

export interface TableFailure {
  message: string;
  onRetry?: (() => void) | undefined;
}

export interface DataTableProps<TData extends RowData, TField extends string = string> {
  className: string;
  columns: readonly ColumnDef<DataTableFeatures, TData, unknown>[];
  data: readonly TData[];
  sort?: TableSort<TField> | undefined;
  virtual?: { rowHeight: number } | undefined;
  rowAttributes?: RowAttributes<TData> | undefined;
  empty?: ReactNode;

  // The rows are on their way. The headers stay, so the sort controls stay reachable and nothing
  // moves when the real rows land — a spinner in the middle of the content tells a reader less and
  // costs them a reflow.
  loading?: boolean | undefined;

  // Named, not swallowed. An empty table and a refused request look identical, and the second one
  // is the one an admin has to do something about.
  error?: TableFailure | undefined;
}

export function DataTable<TData extends RowData, TField extends string = string>({
  className,
  columns,
  data,
  sort,
  virtual,
  rowAttributes,
  empty,
  loading,
  error,
}: DataTableProps<TData, TField>): ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const table = useTable(useMemo(() => ({ features, columns, data }), [columns, data]));
  const rows = table.getRowModel().rows;

  const headers = table.getHeaderGroups();
  const width = headers.at(-1)?.headers.length ?? 1;

  const content = (
    <>
      {/* Virtualised rows are absolutely positioned, so the table only ever holds the dozen the
          viewport can see and a reader counting them announces a dozen of a thousand. */}
      <table
        className={className}
        aria-rowcount={virtual && !loading ? rows.length + 1 : undefined}
        aria-busy={loading || undefined}
      >
        <thead>
          {headers.map((group, position) => (
            <tr key={group.id} aria-rowindex={virtual ? position + 1 : undefined}>
              {group.headers.map((header) => (
                <th
                  key={header.id}
                  scope="col"
                  data-column={header.id}
                  aria-sort={ariaSort(header.id, sort)}
                >
                  <HeaderLabel
                    id={header.id}
                    label={String(header.column.columnDef.header ?? header.id)}
                    sort={sort}
                  />
                </th>
              ))}
            </tr>
          ))}
        </thead>

        {loading ? (
          <SkeletonBody columns={width} height={virtual?.rowHeight ?? DATA_ROW_HEIGHT} />
        ) : error ? null : virtual ? (
          <VirtualBody
            table={table}
            rows={rows}
            scrollRef={scrollRef}
            rowHeight={virtual.rowHeight}
            rowAttributes={rowAttributes}
          />
        ) : (
          <PlainBody table={table} rows={rows} rowAttributes={rowAttributes} />
        )}
      </table>

      {error ? <TableError failure={error} /> : null}
      {!error && !loading && data.length === 0 ? empty : null}
    </>
  );

  if (!virtual) return content;

  return (
    <div className="table-scroll" ref={scrollRef}>
      {content}
    </div>
  );
}

function SkeletonBody({ columns, height }: { columns: number; height: number }): ReactElement {
  return (
    <tbody aria-hidden="true">
      {Array.from({ length: SKELETON_ROWS }, (_, row) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have no identity to key on
        <tr className="table-skeleton-row" key={row} style={{ height: `${height}px` }}>
          {Array.from({ length: columns }, (_, cell) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: as above
            <td key={cell}>
              <span className="skeleton" />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

function TableError({ failure }: { failure: TableFailure }): ReactElement {
  return (
    <div className="table-error" role="alert">
      <span className="table-error-title">Proton could not load these rows.</span>
      <p className="status">{failure.message}</p>
      {failure.onRetry ? (
        <button type="button" className="button button-quiet" onClick={failure.onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

function cellsOf<TData extends RowData>(
  table: ReactTable<DataTableFeatures, TData>,
  row: Row<DataTableFeatures, TData>,
): ReactElement[] {
  return row.getAllCells().map((cell) => (
    <td key={cell.id} data-column={cell.column.id}>
      <table.FlexRender cell={cell} />
    </td>
  ));
}

function PlainBody<TData extends RowData>({
  table,
  rows,
  rowAttributes,
}: {
  table: ReactTable<DataTableFeatures, TData>;
  rows: readonly Row<DataTableFeatures, TData>[];
  rowAttributes: RowAttributes<TData> | undefined;
}): ReactElement {
  return (
    <tbody>
      {rows.map((row) => (
        <tr key={row.id} {...(rowAttributes ? rowAttributes(row.original) : {})}>
          {cellsOf(table, row)}
        </tr>
      ))}
    </tbody>
  );
}

function VirtualBody<TData extends RowData>({
  table,
  rows,
  scrollRef,
  rowHeight,
  rowAttributes,
}: {
  table: ReactTable<DataTableFeatures, TData>;
  rows: readonly Row<DataTableFeatures, TData>[];
  scrollRef: RefObject<HTMLDivElement | null>;
  rowHeight: number;
  rowAttributes: RowAttributes<TData> | undefined;
}): ReactElement {
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 6,

    // Without a starting rect the server renders zero rows and the first paint is an empty table.
    initialRect: { width: 0, height: VIEWPORT_PX },
  });

  return (
    <tbody style={{ height: `${virtualizer.getTotalSize()}px` }}>
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const row = rows[virtualRow.index];
        if (!row) return null;

        return (
          <tr
            key={row.id}
            aria-rowindex={virtualRow.index + 2}
            {...(rowAttributes ? rowAttributes(row.original) : {})}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: `${virtualRow.size}px`,
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            {cellsOf(table, row)}
          </tr>
        );
      })}
    </tbody>
  );
}

function ariaSort<TField extends string>(
  id: string,
  sort: TableSort<TField> | undefined,
): 'ascending' | 'descending' | 'none' | undefined {
  const field = sort?.fields[id];

  if (!sort || !field) return undefined;
  if (sort.field !== field) return 'none';
  return sort.direction === 'asc' ? 'ascending' : 'descending';
}

function HeaderLabel<TField extends string>({
  id,
  label,
  sort,
}: {
  id: string;
  label: string;
  sort: TableSort<TField> | undefined;
}): ReactElement {
  const field = sort?.fields[id];
  if (!sort || !field) return <span>{label}</span>;

  const active = sort.field === field;
  const direction = active && sort.direction === 'asc' ? 'desc' : 'asc';

  return (
    <button
      type="button"
      className="sort-button"
      onClick={() => sort.onSort({ sort: field, direction })}
    >
      {label}
      {active ? (
        <span className="sort-caret">
          <Icon name={sort.direction === 'asc' ? 'caret-up' : 'caret-down'} weight="fill" />
        </span>
      ) : null}
    </button>
  );
}

export function lastPageOf(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

export interface PagerProps {
  className: string;
  page: number;
  lastPage: number;
  onPage: (page: number) => void;
  children: ReactNode;
}

export function Pager({ className, page, lastPage, onPage, children }: PagerProps): ReactElement {
  return (
    <nav className={className} aria-label="Pages">
      <button
        type="button"
        className="button button-quiet"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        Previous
      </button>
      {/* A filter that narrows a thousand cases to four changes nothing a reader is told about
          otherwise — the rows it removed were never announced in the first place. */}
      <span aria-live="polite">{children}</span>
      <button
        type="button"
        className="button button-quiet"
        disabled={page >= lastPage}
        onClick={() => onPage(page + 1)}
      >
        Next
      </button>
    </nav>
  );
}
