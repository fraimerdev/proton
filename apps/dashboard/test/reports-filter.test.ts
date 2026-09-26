import { describe, expect, mock, test } from 'bun:test';
import {
  REPORT_PAGE_SIZE_MAX,
  REPORT_QUERY_STATUSES,
  REPORT_SORTS,
} from '@proton/module-moderation/reports-view';
import { reportListQuerySchema } from '../src/lib/api-client.ts';

mock.module('../src/server/reports.ts', () => ({
  searchReports: async () => null,
  getReportSummary: async () => null,
  getReport: async () => null,
  listReportAutomationRuns: async () => null,
  getCaseEvidence: async () => null,
  actOnReport: async () => null,
}));

const { newRequestId, reportFilter, reportsKey, reportsQuery } = await import(
  '../src/pages/moderation/reports/queries.ts'
);

const GUILD = '900000000000000002';
const MEMBER = '400000000000000002';

describe('reportFilter', () => {
  test('an empty search is the active queue, newest first, one page of 25', () => {
    expect(reportFilter({})).toEqual({
      status: 'active',
      targetId: undefined,
      reporterId: undefined,
      assigneeId: undefined,
      from: undefined,
      to: undefined,
      q: undefined,
      delivery: undefined,
      close: undefined,
      sort: 'created',
      dir: 'desc',
      page: 1,
      pageSize: 25,
      group: undefined,
    });
  });

  test('reads the shared URL keys', () => {
    const query = reportFilter({
      status: 'in_review',
      q: '  #12  ',
      page: 3,
      sort: 'number',
      dir: 'asc',
    });

    expect(query).toMatchObject({
      status: 'in_review',
      q: '#12',
      page: 3,
      sort: 'number',
      dir: 'asc',
    });
  });

  test('every status the api knows passes through; anything else is the active queue', () => {
    for (const status of REPORT_QUERY_STATUSES) {
      expect(reportFilter({ status }).status).toBe(status);
    }
    expect(reportFilter({ status: 'live' }).status).toBe('active');
  });

  test('the open report is not part of the list query, so opening one keeps the list cached', () => {
    expect(reportFilter({ status: 'open', id: 'Rk7f3M2q' })).toEqual(
      reportFilter({ status: 'open' }),
    );
  });

  test('an unknown sort is newest first', () => {
    expect(reportFilter({ sort: 'createdAt' }).sort).toBe('created');
  });

  test('ranking by volume needs the member grouping, and falls back to newest without it', () => {
    expect(reportFilter({ sort: 'volume' }).sort).toBe('created');
    expect(reportFilter({ sort: 'volume' }, { group: true })).toMatchObject({
      sort: 'volume',
      group: 'member',
    });
  });

  test('member filters take Discord ids only; assignee also takes none', () => {
    expect(
      reportFilter({}, { targetId: MEMBER, reporterId: 'someone', assigneeId: 'none' }),
    ).toMatchObject({ targetId: MEMBER, reporterId: undefined, assigneeId: 'none' });
    expect(reportFilter({}, { assigneeId: ` ${MEMBER} ` }).assigneeId).toBe(MEMBER);
  });

  test('dates must be ISO, and a backwards range is left off rather than refused', () => {
    expect(reportFilter({}, { from: '2026-09-01', to: 'yesterday' })).toMatchObject({
      from: '2026-09-01',
      to: undefined,
    });
    expect(reportFilter({}, { from: '2026-09-10', to: '2026-09-01' })).toMatchObject({
      from: undefined,
      to: undefined,
    });
  });

  test('delivery problems and grouping are switches', () => {
    expect(reportFilter({}, { delivery: true, group: true })).toMatchObject({
      delivery: 'problem',
      group: 'member',
    });
    expect(reportFilter({}, { delivery: false, group: false })).toMatchObject({
      delivery: undefined,
      group: undefined,
    });
  });

  test('closing problems are a switch too', () => {
    expect(reportFilter({ status: 'all' }, { close: true })).toMatchObject({
      status: 'all',
      close: 'problem',
    });
    expect(reportFilter({}, { close: false }).close).toBeUndefined();
  });

  test('the page size stays within what the api serves', () => {
    expect(reportFilter({}, { pageSize: 500 }).pageSize).toBe(REPORT_PAGE_SIZE_MAX);
    expect(reportFilter({}, { pageSize: 0 }).pageSize).toBe(1);
    expect(reportFilter({}, { pageSize: Number.NaN }).pageSize).toBe(25);
  });

  test('a search longer than the api accepts is cut to its limit', () => {
    expect(reportFilter({ q: 'x'.repeat(140) }).q).toHaveLength(100);
    expect(reportFilter({ q: '   ' }).q).toBeUndefined();
  });

  test('whatever the URL holds, the result is a query the api accepts', () => {
    const searches = [
      {},
      { status: 'nonsense', sort: 'volume', dir: 'asc' as const, page: 9 },
      { q: '#1', status: 'resolved' },
      { q: 'y'.repeat(400) },
    ];
    const locals = [
      {},
      { group: true, from: '2026-09-01T10:00:00Z', to: '2026-09-02' },
      { assigneeId: 'nobody', pageSize: 99, delivery: true, targetId: '12', close: true },
    ];

    for (const search of searches) {
      for (const local of locals) {
        for (const sort of REPORT_SORTS) {
          const query = reportFilter({ ...search, sort }, local);
          expect(reportListQuerySchema.safeParse(query).success).toBe(true);
        }
      }
    }
  });
});

describe('the report queries', () => {
  test('every list sits under the reports key, so one invalidation refreshes them all', () => {
    const key = reportsQuery(GUILD, reportFilter({})).queryKey;

    expect(key.slice(0, reportsKey(GUILD).length)).toEqual([...reportsKey(GUILD)]);
    expect(reportsKey(GUILD)).toEqual(['guild', GUILD, 'moderation', 'reports']);
  });

  test('a request id is fresh each time and fits the api’s pattern', () => {
    const first = newRequestId();

    expect(first).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(newRequestId()).not.toBe(first);
  });
});
