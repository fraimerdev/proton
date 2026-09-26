import { afterEach, describe, expect, mock, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApplicationDetail, QueueItem, QueueSummary } from '@proton/module-applications/view';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';

const SRC = join(import.meta.dir, '..', 'src');

const GUILD = '900000000000000002';
const APPLICANT = '400000000000000001';
const LEFT = '400000000000000009';
const REVIEWER = '400000000000000002';
const SECOND = '400000000000000003';
const ROLE = '600000000000000001';

const calls: { name: string; data: unknown }[] = [];

for (const file of readdirSync(join(SRC, 'server'))) {
  const text = readFileSync(join(SRC, 'server', file), 'utf8');
  const names = [...text.matchAll(/^export (?:const|(?:async )?function) (\w+)/gm)].map(
    ([, name]) => name as string,
  );

  mock.module(`../src/server/${file}`, () =>
    Object.fromEntries(
      names.map((name) => [
        name,
        async (input?: { data?: unknown }) => {
          calls.push({ name, data: input?.data });
          return null;
        },
      ]),
    ),
  );
}

const QUERIES = readFileSync(join(SRC, 'lib', 'queries.ts'), 'utf8');

mock.module('../src/lib/queries.ts', () => ({
  ...Object.fromEntries(
    [...QUERIES.matchAll(/^export (?:function|const) (\w+)/gm)].map(([, name]) => [
      name,
      (...args: unknown[]) => ({ queryKey: ['stub', name, ...args], enabled: false }),
    ]),
  ),
  MEMBER_LOOKUP_MAX: 100,
  membersQuery: (guildId: string, userIds: readonly string[]) => ({
    queryKey: ['admin-members', guildId, ...[...new Set(userIds)].sort()],
    queryFn: async () => [],
    enabled: userIds.length > 0,
  }),
  moduleConfigQuery: (guildId: string, moduleId: string) => ({
    queryKey: ['admin-config', guildId, moduleId],
    queryFn: () => new Promise(() => {}),
  }),
  rolesQuery: (guildId: string) => ({
    queryKey: ['admin-roles', guildId],
    queryFn: () => new Promise(() => {}),
  }),
}));

const { SubmissionsArea } = await import('../src/pages/applications/submissions.tsx');
const {
  applicationMembersQuery,
  applicationQuery,
  applicationQueueQuery,
  applicationSummaryQuery,
} = await import('../src/pages/applications/queries.ts');
const { queueRequest } = await import('../src/pages/applications/labels.ts');

afterEach(() => {
  calls.length = 0;
});

function item(overrides: Partial<QueueItem>): QueueItem {
  return {
    id: 'app-1',
    number: 12,
    formId: 'moderator',
    formName: 'Moderator Application',
    applicantId: APPLICANT,
    applicantName: 'riley_apply',
    status: 'in_review',
    assigneeId: REVIEWER,
    submittedAt: Date.now() - 3 * 3_600_000,
    updatedAt: Date.now(),
    archived: false,
    problems: [],
    votes: { accept: 2, reject: 1 },
    ...overrides,
  };
}

const ROWS: QueueItem[] = [
  item({}),
  item({
    id: 'app-2',
    number: 13,
    applicantId: LEFT,
    applicantName: 'Sam who left',
    status: 'submitted',
    assigneeId: null,
    votes: { accept: 0, reject: 0 },
    problems: [{ effectId: 'e9', kind: 'add_role', label: 'Role update failed' }],
  }),
];

const SUMMARY: QueueSummary = {
  awaiting: 2,
  unassigned: 1,
  needsInfo: 0,
  waitlisted: 0,
  problems: 1,
  oldestAwaitingAt: Date.now() - 2 * 86_400_000,
};

const MEMBERS = [
  { id: APPLICANT, displayName: 'Riley', username: 'riley', avatarUrl: null, bot: false },
  { id: REVIEWER, displayName: 'Solus', username: 'solus', avatarUrl: null, bot: false },
];

type Search = { view?: string; q?: string; page?: number; id?: string };

function render(
  surface: 'module' | 'review',
  search: Search,
  prime: (client: QueryClient) => void,
): { html: string; client: QueryClient } {
  // Without it a failed query renders as loading again, because mounting would ask once more.
  const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  prime(client);

  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <SubmissionsArea guildId={GUILD} surface={surface} search={search} onSearch={() => {}} />
    </QueryClientProvider>,
  );

  return { html, client };
}

function primeQueue(client: QueryClient, search: Search, rows: QueueItem[]): void {
  client.setQueryData(applicationQueueQuery(GUILD, queueRequest(search, {})).queryKey, {
    items: rows,
    total: rows.length,
    page: 1,
    pageSize: 25,
  });
  client.setQueryData(applicationSummaryQuery(GUILD).queryKey, SUMMARY);
}

function keys(client: QueryClient): string[] {
  return client
    .getQueryCache()
    .getAll()
    .map((query) => JSON.stringify(query.queryKey));
}

describe('the submissions queue', () => {
  test('shows each application with its reference, applicant, status and reviewer', () => {
    const { html } = render('review', {}, (client) => {
      primeQueue(client, {}, ROWS);
      client.setQueryData(
        applicationMembersQuery(GUILD, [REVIEWER, APPLICANT, LEFT]).queryKey,
        MEMBERS,
      );
    });

    expect(html).toContain('Awaiting review (2)');
    expect(html).toContain('#12');
    expect(html).toContain('#13');
    expect(html).toContain('Riley');
    expect(html).toContain('Sam who left');
    expect(html).toContain('Solus');
    expect(html).toContain('Nobody');
    expect(html).toContain('In review');
    expect(html).toContain('Role update failed');
    expect(html).toContain('2 accept · 1 reject');
    expect(html).toContain('1 unassigned');
    expect(html).toContain('1 with failed actions');
    expect(html).toContain('placeholder="#number, member ID or name"');
    expect(html).not.toContain('Loading applications');
  });

  test('a reviewer’s names come through the reviewer lookup, not the admin one', () => {
    const { client } = render('review', {}, (client) => primeQueue(client, {}, ROWS));
    const cached = keys(client);

    expect(cached.some((key) => key.includes('"applications","members"'))).toBe(true);
    expect(cached.some((key) => key.includes('admin-members'))).toBe(false);
  });

  test('the module page keeps the admin lookup', () => {
    const { client } = render('module', {}, (client) => primeQueue(client, {}, ROWS));
    const cached = keys(client);

    expect(cached.some((key) => key.includes('admin-members'))).toBe(true);
    expect(cached.some((key) => key.includes('"applications","members"'))).toBe(false);
  });

  test('a search that matches nothing offers to clear it', () => {
    const { html } = render('module', { q: 'nobody' }, (client) =>
      primeQueue(client, { q: 'nobody' }, []),
    );

    expect(html).toContain('No applications match these filters');
    expect(html).toContain('Clear filters');
  });

  test('an empty list says why, per view', () => {
    const { html } = render('module', { view: 'all' }, (client) =>
      primeQueue(client, { view: 'all' }, []),
    );

    expect(html).toContain('No applications yet');
    expect(html).not.toContain('Clear filters');
  });

  test('a member outside every review team gets a plain refusal, not an error', () => {
    const refusal = 'You aren’t on a review team for Applications in this server.';
    const { html } = render('review', {}, (client) => {
      const query = client
        .getQueryCache()
        .build(client, { queryKey: applicationQueueQuery(GUILD, queueRequest({}, {})).queryKey });
      query.setState({
        ...query.state,
        status: 'error',
        error: new Error(refusal),
        fetchStatus: 'idle',
      });
    });

    expect(html).toContain('You can’t review applications here');
    expect(html).toContain(refusal);
  });
});

function detail(overrides: Partial<ApplicationDetail> = {}): ApplicationDetail {
  return {
    application: {
      ...item({ status: 'accepted', assigneeId: REVIEWER }),
      problems: [{ effectId: 'e1', kind: 'add_role', label: 'Role update failed' }],
      versionId: 'v2',
      version: 2,
      decidedAt: Date.now() - 60_000,
      decidedBy: REVIEWER,
      decisionReason: 'Welcome aboard',
      reopenedCount: 0,
      archivedAt: null,
      contentPurgedAt: null,
      deletedAt: null,
      interview: null,
      cardUrl: `https://discord.com/channels/${GUILD}/1/2`,
    },
    answers: [
      {
        questionId: 'why',
        sectionId: 'about',
        label: 'Why do you want to help?',
        type: 'paragraph',
        value: 'I like keeping things tidy.',
        display: 'I like keeping things tidy.',
      },
      {
        questionId: 'portfolio',
        sectionId: 'work',
        label: 'Portfolio',
        type: 'url',
        value: 'https://example.com/me',
        display: 'https://example.com/me',
      },
    ],
    sections: [
      { id: 'about', title: 'About you' },
      { id: 'work', title: 'Your work' },
    ],
    thread: [
      {
        id: 't1',
        kind: 'decision',
        authorId: REVIEWER,
        body: 'Welcome aboard',
        createdAt: Date.now() - 60_000,
      },
    ],
    notes: [
      { id: 'n1', authorId: SECOND, body: 'Strong answers.', createdAt: Date.now() - 120_000 },
    ],
    votes: [{ reviewerId: SECOND, vote: 'accept', score: 4, updatedAt: Date.now() - 90_000 }],
    history: [
      {
        id: 'h1',
        kind: 'claimed',
        actorId: REVIEWER,
        source: 'discord',
        fromStatus: 'submitted',
        toStatus: 'in_review',
        createdAt: Date.now() - 300_000,
      },
      {
        id: 'h2',
        kind: 'accepted',
        actorId: REVIEWER,
        source: 'dashboard',
        fromStatus: 'in_review',
        toStatus: 'accepted',
        createdAt: Date.now() - 60_000,
      },
    ],
    effects: [
      {
        id: 'e1',
        key: `accepted:3:add_role:${ROLE}`,
        kind: 'add_role',
        status: 'failed',
        attempts: 5,
        error: 'Proton’s role is below this role.',
        errorCode: 'hierarchy',
        updatedAt: Date.now() - 30_000,
        label: 'Add role',
      },
      {
        id: 'e2',
        key: 'accepted:3:dm',
        kind: 'dm',
        status: 'succeeded',
        attempts: 1,
        error: null,
        errorCode: null,
        updatedAt: Date.now() - 30_000,
        label: 'DM to the applicant',
      },
      {
        id: 'e3',
        key: 'event:accepted:3',
        kind: 'event',
        status: 'succeeded',
        attempts: 1,
        error: null,
        errorCode: null,
        updatedAt: Date.now() - 30_000,
        label: 'Update for other modules',
      },
    ],
    capabilities: ['view', 'review', 'decide', 'override', 'export', 'delete'],
    moderation: null,
    twoReviewers: false,
    scoring: true,
    ...overrides,
  };
}

describe('the application detail', () => {
  test('puts the answers first and marks what the applicant sees', () => {
    const { html } = render('module', { id: 'app-1' }, (client) =>
      client.setQueryData(applicationQuery(GUILD, 'app-1').queryKey, detail()),
    );

    expect(html).toContain('Back to submissions');
    expect(html).toContain('Moderator Application');
    expect(html).toContain('Asked as version 2');
    expect(html).toContain('About you');
    expect(html).toContain('I like keeping things tidy.');
    expect(html).toContain('href="https://example.com/me"');
    expect(html).toContain('rel="noopener noreferrer nofollow ugc"');
    expect(html).toContain('The applicant sees this');
    expect(html).toContain('Only staff see this');
    expect(html).toContain('Strong answers.');
    expect(html).toContain('Average score 4 / 5');
    expect(html.indexOf('Answers')).toBeLessThan(html.indexOf('History'));
  });

  test('an accepted application with a failed role update says so, and offers only that retry', () => {
    const { html } = render('module', { id: 'app-1' }, (client) =>
      client.setQueryData(applicationQuery(GUILD, 'app-1').queryKey, detail()),
    );

    expect(html).toContain('Accepted · role update failed');
    expect(html).toContain('The decision is saved.');
    expect(html).toContain('aria-label="Try Add role again"');
    expect(html).not.toContain('aria-label="Try DM to the applicant again"');
    expect(html).not.toContain('Update for other modules');
    expect(html).toContain('Proton’s role is below this role.');
    expect(html).toContain('Reopen…');
    expect(html).not.toContain('Accept…');
  });

  test('a reviewer who can’t decide is told who can', () => {
    const pending = detail({
      application: { ...detail().application, status: 'in_review', problems: [] },
      capabilities: ['view', 'review'],
      effects: [],
    });
    const { html } = render('review', { id: 'app-1' }, (client) =>
      client.setQueryData(applicationQuery(GUILD, 'app-1').queryKey, pending),
    );

    expect(html).toContain('Only deciders on this form’s review team can accept or reject it.');
    expect(html).not.toContain('Accept…');
    expect(html).toContain('Request information…');
  });

  test('purged answers say when and why they went', () => {
    const purged = detail({
      answers: null,
      application: { ...detail().application, contentPurgedAt: Date.UTC(2026, 8, 1) },
    });
    const { html } = render('module', { id: 'app-1' }, (client) =>
      client.setQueryData(applicationQuery(GUILD, 'app-1').queryKey, purged),
    );

    expect(html).toContain('The answers were deleted on');
    expect(html).toContain('keep-for setting');
    expect(html).not.toContain('Reopen…');
  });

  test('never renders an em dash', () => {
    const { html } = render('module', { id: 'app-1' }, (client) =>
      client.setQueryData(applicationQuery(GUILD, 'app-1').queryKey, detail()),
    );

    expect(html).not.toContain('—');
  });
});
