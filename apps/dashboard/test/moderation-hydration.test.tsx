import { afterEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reportDetailSchema } from '@proton/module-moderation/reports-view';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { renderToString } from 'react-dom/server';

const SRC = join(import.meta.dir, '..', 'src');
const GUILD = '900000000000000002';
const GENERAL = '500000000000000001';
const AUTHOR = '400000000000000002';
const REPORTER = '400000000000000003';
const REPORT_ID = 'Rk7f3M2q';
const CASE = 'K7f3M2q';
const FETCHED = Date.parse('2026-09-18T14:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const answers: Record<string, () => unknown> = {};

for (const file of readdirSync(join(SRC, 'server'))) {
  const source = readFileSync(join(SRC, 'server', file), 'utf8');
  const names = [...source.matchAll(/^export (?:const|(?:async )?function) (\w+)/gm)].map(
    ([, name]) => name as string,
  );

  mock.module(`../src/server/${file}`, () =>
    Object.fromEntries(names.map((name) => [name, async () => answers[name]?.() ?? null])),
  );
}

const QUERIES = readFileSync(join(SRC, 'lib', 'queries.ts'), 'utf8');

const stubs = Object.fromEntries(
  [...QUERIES.matchAll(/^export (?:function|const) (\w+)/gm)].map(([, name]) => [
    name,
    (...args: unknown[]) => ({
      queryKey: ['stub', name, ...args],
      queryFn: async () => null,
      enabled: false,
    }),
  ]),
);

const CHANNELS = [{ id: GENERAL, name: 'commands', type: 0, parentId: null }];

mock.module('../src/lib/queries.ts', () => ({
  ...stubs,
  MEMBER_LOOKUP_MAX: 100,
  channelsQuery: (guildId: string) => ({
    queryKey: ['hydration', 'channels', guildId],
    queryFn: async () => CHANNELS,
  }),
  rolesQuery: (guildId: string) => ({
    queryKey: ['hydration', 'roles', guildId],
    queryFn: async () => [],
  }),
}));

const route = await import('../src/components/module/route.tsx');
let search: Record<string, unknown> = {};

mock.module('../src/components/module/route.tsx', () => ({
  ...route,
  useModuleSearch: () => search,
  useModuleNavigate: () => () => undefined,
  ModuleLink: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <a className={className} href="#module">
      {children}
    </a>
  ),
}));

const { EvidenceSection } = await import('../src/pages/moderation/reports/evidence.tsx');
const { ReportTimeline } = await import('../src/pages/moderation/reports/timeline.tsx');
const { useNow, When } = await import('../src/pages/moderation/reports/when.tsx');
const { ReportDetailView } = await import('../src/pages/moderation/reports/detail.tsx');
const { BlockedArea } = await import('../src/pages/moderation/blocked.tsx');
const { prefetchArea } = await import('../src/lib/modules/area-prefetch.ts');

type Report = Parameters<typeof EvidenceSection>[0]['report'];
type Events = Parameters<typeof ReportTimeline>[0]['events'];

const seconds = (ms: number): number => Math.floor(ms / 1000);

const REPORT: Report = {
  evidence: {
    message: {
      status: 'captured',
      snapshot: {
        id: '600000000000000001',
        channelId: GENERAL,
        authorId: AUTHOR,
        authorName: 'riley',
        authorBot: false,
        url: `https://discord.com/channels/${GUILD}/${GENERAL}/600000000000000001`,
        createdAt: FETCHED - HOUR,
        editedAt: null,
        content: `the raid starts <t:${seconds(FETCHED + HOUR)}:R>`,
        attachments: [
          {
            id: 'a1',
            filename: 'proof.png',
            contentType: 'image/png',
            size: 20_480,
            url: 'https://cdn.discordapp.com/attachments/1/2/proof.png?ex=1',
            expiresAt: FETCHED + 2 * HOUR,
          },
        ],
        embeds: [],
        stickers: [],
        forwarded: false,
        forwardedContent: null,
        capturedFrom: 'interaction',
      },
    },
    links: [],
    attachments: [],
  },
  evidencePurgedAt: null,
  evidenceExpiresAt: FETCHED + 30 * 86_400_000,
  createdAt: FETCHED - 2 * HOUR,
  resolvedAt: null,
};

const EVENTS: Events = [
  {
    id: 'e1',
    reportId: 'r1',
    kind: 'action_failed',
    actorId: 'proton:reports',
    source: 'system',
    data: {
      kind: 'timeout',
      message: `Discord is busy. Proton tries again <t:${seconds(FETCHED + 30 * MINUTE)}:R>.`,
    },
    createdAt: FETCHED - 5 * MINUTE,
  },
];

const REPORT_DETAIL = reportDetailSchema.parse({
  id: REPORT_ID,
  guildId: GUILD,
  number: 7,
  reporterId: REPORTER,
  targetId: AUTHOR,
  method: 'message_menu',
  status: 'open',
  reasonId: null,
  reason: 'Raid threats',
  customReason: null,
  comment: null,
  sourceChannelId: GENERAL,
  sourceMessageId: '600000000000000001',
  sourceAuthorId: AUTHOR,
  evidence: REPORT.evidence,
  evidenceExpiresAt: REPORT.evidenceExpiresAt,
  evidencePurgedAt: null,
  assigneeId: null,
  assignedAt: null,
  resolvedBy: null,
  resolvedAt: null,
  resolutionNote: null,
  reporterNote: null,
  actionKind: null,
  caseIds: [],
  card: {
    channelId: null,
    messageId: null,
    evidenceMessageId: null,
    state: 'posted',
    error: null,
    attempts: 1,
    version: 1,
  },
  close: { action: null, dueAt: null, closedAt: null, attempts: 0, error: null },
  notifications: {},
  version: 1,
  createdAt: FETCHED - 2 * HOUR,
  updatedAt: FETCHED - 5 * MINUTE,
  deciding: false,
  events: EVENTS,
  related: [],
  cases: [],
  stats: { total: 1, distinctReporters: 1, open: 1 },
});

const BLOCKED = {
  rows: [
    {
      id: 'blocked-1',
      guildId: GUILD,
      userId: AUTHOR,
      moduleId: 'honeypot',
      blockedBy: 'proton:honeypot',
      reason: 'Posted in a bait channel',
      caseId: CASE,
      evidence: { channelId: GENERAL, messageId: '600000000000000009' },
      createdAt: new Date(FETCHED - 5 * MINUTE).toISOString(),
      liftedAt: null,
      liftedBy: null,
      liftReason: null,
    },
  ],
  total: 1,
};

async function prefetched(link: Record<string, unknown>): Promise<QueryClient> {
  search = link;
  answers.searchBlockedMembers = () => BLOCKED;
  answers.getReport = () => REPORT_DETAIL;
  answers.getReportSummary = () => ({
    counts: { open: 1, in_review: 0, accepted: 0, dismissed: 0 },
    openUnclaimed: 1,
    oldestOpenAt: REPORT_DETAIL.createdAt,
    deliveryProblems: 0,
  });

  const client = new QueryClient();
  setSystemTime(new Date(FETCHED));
  await prefetchArea(client, GUILD, 'moderation', link);

  return client;
}

function renderedAt(client: QueryClient, element: ReactElement, clock: number): string {
  setSystemTime(new Date(clock));
  return renderToString(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

function Submitted({ at }: { at: number }): ReactElement {
  const now = useNow(FETCHED);
  return <When at={at} now={now} prefix="Submitted " />;
}

function Detail(): ReactElement {
  const now = useNow(FETCHED);

  return (
    <>
      <EvidenceSection guildId={GUILD} report={REPORT} now={now} />
      <ReportTimeline guildId={GUILD} events={EVENTS} now={now} mentionNames={new Map()} />
    </>
  );
}

function serverRender(element: ReactElement, clock: number): string {
  setSystemTime(clock);
  return renderToString(element);
}

const text = (markup: string): string => markup.replaceAll('<!-- -->', '');

afterEach(() => {
  setSystemTime();
  search = {};
});

describe('moderation pages rendered on the server', () => {
  test('a relative time is measured from when the data was fetched, not the wall clock', () => {
    const markup = serverRender(<Submitted at={FETCHED - 5 * MINUTE} />, FETCHED + 10 * MINUTE);

    expect(text(markup)).toContain('>Submitted 5m ago</time>');
  });

  test('the local-time tooltip waits for the browser', () => {
    const markup = serverRender(<Submitted at={FETCHED - 5 * MINUTE} />, FETCHED);

    expect(markup).not.toContain('title=');
  });

  test('a report detail prints the same markup whichever minute the server and browser read', () => {
    const early = serverRender(<Detail />, FETCHED + MINUTE);
    const late = serverRender(<Detail />, FETCHED + 3 * HOUR);

    expect(late).toBe(early);
    expect(text(late)).toContain('Link from Discord, expires in 2h');
    expect(late).toContain('href="https://cdn.discordapp.com/attachments/1/2/proof.png?ex=1"');
    expect(text(late)).toContain('the raid starts <span class="dc-mention">in 1 hour</span>');
    expect(text(late)).toContain('Discord is busy. Proton tries again in 30m.');
    expect(text(late)).toContain('>5m ago</time>');
  });

  test('a blocked-members link prints the same markup whichever minute the server and browser read', async () => {
    const client = await prefetched({ area: 'blocked' });
    const area = <BlockedArea guildId={GUILD} moduleId="moderation" />;

    const early = renderedAt(client, area, FETCHED + MINUTE);
    const late = renderedAt(client, area, FETCHED + 3 * HOUR);

    expect(late).toBe(early);
    expect(late).not.toContain('Loading blocked members');
    expect(text(late)).toContain('>5m ago</time>');
    expect(late).toContain('Posted in a bait channel');
    expect(late).not.toMatch(/<time[^>]*title=/);
  });

  test('a report link prints the same markup whichever minute the server and browser read', async () => {
    const client = await prefetched({ area: 'reports-queue', id: REPORT_ID });
    const view = (
      <ReportDetailView
        guildId={GUILD}
        moduleId="moderation"
        reportId={REPORT_ID}
        onFilterMember={() => undefined}
      />
    );

    const early = renderedAt(client, view, FETCHED + MINUTE);
    const late = renderedAt(client, view, FETCHED + 3 * HOUR);

    expect(late).toBe(early);
    expect(late).not.toContain('Loading report');
    expect(text(late)).toContain('>Submitted 2h ago</time>');
    expect(text(late)).toContain('#commands');
    expect(text(late)).toContain('Link from Discord, expires in 2h');
    expect(text(late)).toContain('Discord is busy. Proton tries again in 30m.');
    expect(late).not.toMatch(/<time[^>]*title=/);
  });

  test.each([
    'pages/moderation/blocked.tsx',
    'pages/moderation/reports/detail.tsx',
    'pages/moderation/reports/queue.tsx',
    'pages/moderation/reports/evidence.tsx',
    'pages/moderation/reports/timeline.tsx',
    'pages/moderation/reports/overview.tsx',
    'pages/moderation/reports/automation.tsx',
  ])('%s takes the time from useNow, never from the wall clock', (file) => {
    expect(readFileSync(join(SRC, file), 'utf8')).not.toMatch(/\bDate\.now\b/);
  });
});
