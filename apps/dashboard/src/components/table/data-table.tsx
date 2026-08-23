import type { ColumnDef, ColumnHelper, ReactTable, Row, RowData } from '@tanstack/react-table';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { type ReactElement, type ReactNode, type RefObject, useMemo, useRef } from 'react';
import { Icon } from '../shell/icon.tsx';

const features = tableFeatures({});

// Tracks the max-height on .table-scroll. Overshooting it makes the server render rows the client
// then throws away; the virtualiser has no way to measure the element before the first paint.
const VIEWPORT_PX = 544;

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

export interface DataTableProps<TData extends RowData, TField extends string = string> {
  className: string;
  columns: readonly ColumnDef<DataTableFeatures, TData, unknown>[];
  data: readonly TData[];
  sort?: TableSort<TField> | undefined;
  virtual?: { rowHeight: number } | undefined;
  rowAttributes?: RowAttributes<TData> | undefined;
  empty?: ReactNode;
}

export function DataTable<TData extends RowData, TField extends string = string>({
  className,
  columns,
  data,
  sort,
  virtual,
  rowAttributes,
  empty,
}: DataTableProps<TData, TField>): ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const table = useTable(useMemo(() => ({ features, columns, data }), [columns, data]));
  const rows = table.getRowModel().rows;

  const content = (
    <>
      <table className={className}>
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
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

        {virtual ? (
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

      {data.length === 0 ? empty : null}
    </>
  );

  if (!virtual) return content;

  return (
    <div className="table-scroll" ref={scrollRef}>
      {content}
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
    <nav className={className}>
      <button
        type="button"
        className="button button-quiet"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        Previous
      </button>
      {children}
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
