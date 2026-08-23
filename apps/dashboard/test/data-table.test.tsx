import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CASE_SORT_FIELDS,
  type CaseQueryInput,
  type CaseSortField,
  caseQuerySchema,
} from '@proton/core';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DataTable,
  dataColumnHelper,
  lastPageOf,
  Pager,
  type TableSort,
} from '../src/components/table/data-table.tsx';

interface Person {
  rank: number;
  name: string;
  joinedAt: string;
}

const column = dataColumnHelper<Person>();

const columns = column.columns([
  column.accessor('rank', { id: 'rank', header: '#', cell: (c) => `#${c.getValue()}` }),
  column.accessor('name', { id: 'name', header: 'Name' }),
  column.accessor('joinedAt', { id: 'joinedAt', header: 'Joined' }),
]);

const PEOPLE: Person[] = [
  { rank: 1, name: 'Ada', joinedAt: '2026-01-01' },
  { rank: 2, name: 'Grace', joinedAt: '2026-02-01' },
];

const SORTABLE: Record<string, 'rank' | 'joinedAt'> = { rank: 'rank', joinedAt: 'joinedAt' };

function sortedBy(
  field: 'rank' | 'joinedAt',
  direction: 'asc' | 'desc',
): TableSort<'rank' | 'joinedAt'> {
  return { fields: SORTABLE, field, direction, onSort: () => undefined };
}

function render(node: ReactElement): string {
  return renderToStaticMarkup(node);
}

describe('the shared data table', () => {
  test('it renders one header cell per column, each naming its column', () => {
    const html = render(<DataTable className="table" columns={columns} data={PEOPLE} />);

    expect(html.split('scope="col"').length - 1).toBe(3);
    expect(html).toContain('data-column="rank"');
    expect(html).toContain('data-column="name"');
    expect(html).toContain('data-column="joinedAt"');
  });

  test('it runs each column’s own cell renderer rather than printing the raw value', () => {
    const html = render(<DataTable className="table" columns={columns} data={PEOPLE} />);

    expect(html).toContain('#1');
    expect(html).toContain('#2');
    expect(html).toContain('Ada');
    expect(html).toContain('Grace');
  });

  test('it carries the caller’s own row attributes onto each row', () => {
    const html = render(
      <DataTable
        className="table"
        columns={columns}
        data={PEOPLE}
        rowAttributes={(row) => ({ 'data-rank': row.rank })}
      />,
    );

    expect(html).toContain('data-rank="1"');
    expect(html).toContain('data-rank="2"');
  });

  test('the class name the caller asks for is the one the table gets', () => {
    expect(render(<DataTable className="cases-table" columns={columns} data={PEOPLE} />)).toContain(
      'class="cases-table"',
    );
  });
});

describe('sorting a data table from the URL', () => {
  test('an unsorted table announces no sort order at all', () => {
    const html = render(<DataTable className="table" columns={columns} data={PEOPLE} />);

    expect(html).not.toContain('aria-sort');
    expect(html).not.toContain('sort-button');
  });

  test('the active column announces its direction and every other sortable one announces none', () => {
    const html = render(
      <DataTable
        className="table"
        columns={columns}
        data={PEOPLE}
        sort={sortedBy('rank', 'desc')}
      />,
    );

    expect(html).toContain('aria-sort="descending"');
    expect(html).toContain('aria-sort="none"');
    expect(html.split('aria-sort').length - 1).toBe(2);
  });

  test('an ascending sort announces ascending, not the raw direction', () => {
    const html = render(
      <DataTable
        className="table"
        columns={columns}
        data={PEOPLE}
        sort={sortedBy('rank', 'asc')}
      />,
    );

    expect(html).toContain('aria-sort="ascending"');
    expect(html).toContain('data-icon="caret-up"');
  });

  test('a column that cannot be sorted is a label, not a dead button', () => {
    const html = render(
      <DataTable
        className="table"
        columns={columns}
        data={PEOPLE}
        sort={sortedBy('rank', 'desc')}
      />,
    );

    expect(html).toContain('<span>Name</span>');
    expect(html.split('sort-button').length - 1).toBe(2);
  });
});

describe('a virtualised data table', () => {
  test('it renders its rows inside a scroll container so the header can stay put', () => {
    const html = render(
      <DataTable
        className="cases-table"
        columns={columns}
        data={PEOPLE}
        virtual={{ rowHeight: 38 }}
      />,
    );

    expect(html).toContain('class="table-scroll"');
    expect(html).toContain('position:absolute');
    expect(html).toContain('Ada');
  });

  test('a plain table has no scroll container and no positioned rows', () => {
    const html = render(<DataTable className="table" columns={columns} data={PEOPLE} />);

    expect(html).not.toContain('table-scroll');
    expect(html).not.toContain('position:absolute');
  });

  test('a virtualised row still carries the caller’s row attributes', () => {
    const html = render(
      <DataTable
        className="cases-table"
        columns={columns}
        data={PEOPLE}
        virtual={{ rowHeight: 38 }}
        rowAttributes={(row) => ({ 'data-rank': row.rank })}
      />,
    );

    expect(html).toContain('data-rank="1"');
    expect(html).toContain('data-rank="2"');
  });

  test('rows are rendered on the server too, so the first paint is not an empty table', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      rank: i + 1,
      name: `Member ${i + 1}`,
      joinedAt: '2026-01-01',
    }));

    const html = render(
      <DataTable
        className="cases-table"
        columns={columns}
        data={many}
        virtual={{ rowHeight: 38 }}
      />,
    );

    expect(html).toContain('Member 1');
    expect(html.split('<tr').length - 1).toBeGreaterThan(1);
  });
});

describe('what a data table shows when it has no rows', () => {
  test('the empty message appears only once there is nothing to show', () => {
    const empty = <p className="status">Nothing matched.</p>;

    expect(
      render(<DataTable className="table" columns={columns} data={[]} empty={empty} />),
    ).toContain('Nothing matched.');
    expect(
      render(<DataTable className="table" columns={columns} data={PEOPLE} empty={empty} />),
    ).not.toContain('Nothing matched.');
  });

  test('the headers survive an empty result, so the sort controls stay reachable', () => {
    const html = render(
      <DataTable
        className="table"
        columns={columns}
        data={[]}
        sort={sortedBy('rank', 'desc')}
        empty={<p className="status">Nothing matched.</p>}
      />,
    );

    expect(html).toContain('sort-button');
    expect(html).toContain('Nothing matched.');
  });
});

describe('paging a data table', () => {
  test('an empty result still has a first page rather than a zeroth one', () => {
    expect(lastPageOf(0, 50)).toBe(1);
  });

  test('a result that exactly fills its pages does not gain an empty trailing one', () => {
    expect(lastPageOf(100, 50)).toBe(2);
    expect(lastPageOf(101, 50)).toBe(3);
  });

  test('the first page cannot go back and the last page cannot go on', () => {
    const first = render(
      <Pager className="pager" page={1} lastPage={3} onPage={() => undefined}>
        <span>1 of 3</span>
      </Pager>,
    );
    const last = render(
      <Pager className="pager" page={3} lastPage={3} onPage={() => undefined}>
        <span>3 of 3</span>
      </Pager>,
    );

    expect(first.split('disabled').length - 1).toBe(1);
    expect(first).toContain('>Previous</button>');
    expect(last.split('disabled').length - 1).toBe(1);
    expect(
      render(
        <Pager className="pager" page={2} lastPage={3} onPage={() => undefined}>
          <span>2 of 3</span>
        </Pager>,
      ),
    ).not.toContain('disabled');
  });

  test('a single page disables both directions rather than pretending there is more', () => {
    const html = render(
      <Pager className="pagination" page={1} lastPage={1} onPage={() => undefined}>
        <span>1 of 1</span>
      </Pager>,
    );

    expect(html.split('disabled').length - 1).toBe(2);
    expect(html).toContain('class="pagination"');
  });
});

interface CaseRow {
  caseNumber: number;
  type: string;
  createdAt: string;
}

const caseColumn = dataColumnHelper<CaseRow>();

const caseColumns = caseColumn.columns([
  caseColumn.accessor('caseNumber', {
    id: 'caseNumber',
    header: '#',
    cell: (c) => `#${c.getValue()}`,
  }),
  caseColumn.accessor('type', { id: 'type', header: 'Action' }),
  caseColumn.accessor('createdAt', { id: 'createdAt', header: 'When (UTC)' }),
]);

const CASES: CaseRow[] = [
  { caseNumber: 12, type: 'timeout', createdAt: '2026-08-01 09:30' },
  { caseNumber: 11, type: 'ban', createdAt: '2026-07-30 22:05' },
];

const CASE_SORTABLE: Record<string, CaseSortField> = {
  createdAt: 'createdAt',
  caseNumber: 'caseNumber',
};

function headerSorts(html: string): Record<string, string | null> {
  const sorts: Record<string, string | null> = {};

  for (const header of html.match(/<th\b[^>]*>/g) ?? []) {
    const id = /data-column="([^"]+)"/.exec(header)?.[1];
    if (!id) continue;

    sorts[id] = /aria-sort="([^"]+)"/.exec(header)?.[1] ?? null;
  }

  return sorts;
}

function caseSort(field: CaseSortField, direction: 'asc' | 'desc'): TableSort<CaseSortField> {
  return { fields: CASE_SORTABLE, field, direction, onSort: () => undefined };
}

function renderForSearch(search: CaseQueryInput): string {
  const query = caseQuerySchema.parse(search);

  return render(
    <DataTable
      className="cases-table"
      columns={caseColumns}
      data={CASES}
      sort={caseSort(query.sort, query.direction)}
    />,
  );
}

describe('the sort order a case search’s parameters imply', () => {
  test('an address bar with no sort at all announces the default the schema fills in', () => {
    expect(headerSorts(renderForSearch({}))).toEqual({
      caseNumber: 'none',
      type: null,
      createdAt: 'descending',
    });
  });

  test('sorting by case number moves the announcement off the date column', () => {
    expect(headerSorts(renderForSearch({ sort: 'caseNumber', direction: 'asc' }))).toEqual({
      caseNumber: 'ascending',
      type: null,
      createdAt: 'none',
    });
  });

  test('a column the case search cannot sort by announces nothing rather than none', () => {
    expect(headerSorts(renderForSearch({ sort: 'createdAt', direction: 'asc' })).type).toBeNull();
    expect(renderForSearch({}).split('sort-button').length - 1).toBe(2);
  });

  test('the active column’s arrow follows the direction, not the column', () => {
    expect(renderForSearch({ sort: 'caseNumber', direction: 'desc' })).toContain(
      'data-icon="caret-down"',
    );
    expect(renderForSearch({ sort: 'caseNumber', direction: 'asc' })).toContain(
      'data-icon="caret-up"',
    );
  });
});

function noMatches(): ReactElement {
  return (
    <div className="empty-state">
      <span className="empty-state-title">No cases match these filters.</span>
      <p className="status">
        Proton records a case for every action it takes, so an empty list here means nothing matched
        — not that moderation is not being logged.
      </p>
      <button type="button" className="button button-quiet" onClick={() => undefined}>
        Clear filters
      </button>
    </div>
  );
}

function pastTheEnd(page: number, total: number): ReactElement {
  return (
    <div className="empty-state">
      <p className="status">
        Page {page} is past the end of {total} matching {total === 1 ? 'case' : 'cases'}.
      </p>
      <button type="button" className="button button-quiet" onClick={() => undefined}>
        Go to the last page
      </button>
    </div>
  );
}

describe('the two empty states of the cases table', () => {
  test('a search that matched nothing says so without implying moderation went unlogged', () => {
    const html = render(
      <DataTable
        className="cases-table"
        columns={caseColumns}
        data={[]}
        virtual={{ rowHeight: 38 }}
        empty={noMatches()}
      />,
    );

    expect(html).toContain('No cases match these filters.');
    expect(html).toContain('not that moderation is not being logged');
  });

  test('a page past the end names the page and offers the last one instead', () => {
    const html = render(
      <DataTable
        className="cases-table"
        columns={caseColumns}
        data={[]}
        virtual={{ rowHeight: 38 }}
        empty={pastTheEnd(9, 12)}
      />,
    );

    expect(html).toContain('Page 9 is past the end of 12 matching cases.');
    expect(html).toContain('Go to the last page');
    expect(html).not.toContain('No cases match these filters.');
  });

  test('the page-past-the-end state renders even though the search matched cases', () => {
    const html = render(
      <DataTable
        className="cases-table"
        columns={caseColumns}
        data={[]}
        virtual={{ rowHeight: 38 }}
        empty={pastTheEnd(2, 1)}
      />,
    );

    expect(html).toContain('past the end of 1 matching case.');
  });

  test('neither empty state appears while the page has cases on it', () => {
    for (const empty of [noMatches(), pastTheEnd(9, 12)]) {
      const html = render(
        <DataTable
          className="cases-table"
          columns={caseColumns}
          data={CASES}
          virtual={{ rowHeight: 38 }}
          empty={empty}
        />,
      );

      expect(html).not.toContain('class="status"');
      expect(html).toContain('#12');
    }
  });

  test('an empty page keeps its headers, so the sort controls stay reachable', () => {
    const html = render(
      <DataTable
        className="cases-table"
        columns={caseColumns}
        data={[]}
        virtual={{ rowHeight: 38 }}
        sort={caseSort('createdAt', 'desc')}
        empty={noMatches()}
      />,
    );

    expect(headerSorts(html).createdAt).toBe('descending');
    expect(html).toContain('No cases match these filters.');
  });
});

const CASES_VIEW = join(import.meta.dir, '..', 'src', 'components', 'views', 'views.tsx');

function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function renderedText(node: ReactElement): string {
  return flatten(render(node).replace(/<[^>]+>/g, ''));
}

// Per text run, not one string: the shipped empty state is a heading, a paragraph and a button, so
// its copy is never contiguous in the source even when every word of it is quoted here.
function renderedRuns(node: ReactElement): string[] {
  return render(node)
    .split(/<[^>]+>/)
    .map((run) => flatten(run))
    .filter((run) => run.length > 0);
}

describe('the empty states this file reproduces are the ones the cases view ships', () => {
  const view = flatten(readFileSync(CASES_VIEW, 'utf8'));

  test('the no-matches copy is quoted from the view, not invented here', () => {
    const runs = renderedRuns(noMatches());

    expect(runs.length).toBe(3);
    for (const run of runs) expect(view).toContain(run);
  });

  test('the past-the-end state keeps the view’s wording and its way back', () => {
    expect(view).toContain('is past the end of');
    expect(view).toContain('Go to the last page');
    expect(renderedText(pastTheEnd(9, 12))).toContain(
      'Page 9 is past the end of 12 matching cases',
    );
  });

  test('the view picks between them on the total, so both are reachable', () => {
    expect(view).toContain('result.total === 0 ?');
    expect(view).toContain("result.total === 1 ? 'case' : 'cases'");
  });
});

describe('the columns a case table must be able to announce a sort on', () => {
  test('every field the case query can sort by has a column that announces it', () => {
    expect(Object.keys(CASE_SORTABLE).sort()).toEqual([...CASE_SORT_FIELDS].sort());
  });

  test('each of those fields announces its direction when the search selects it', () => {
    for (const field of CASE_SORT_FIELDS) {
      expect(
        `${field}: ${headerSorts(renderForSearch({ sort: field, direction: 'asc' }))[field]}`,
      ).toBe(`${field}: ascending`);
    }
  });
});
