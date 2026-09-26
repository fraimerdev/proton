import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CaseEvidenceView } from '@proton/module-moderation/reports-view';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';

const GUILD = '900000000000000002';
const CASE = 'K7f3M2q';
const AUTHOR = '400000000000000002';
const GENERAL = '500000000000000001';
const NOW = Date.parse('2026-09-18T14:00:00.000Z');

const QUERIES = readFileSync(join(import.meta.dir, '..', 'src', 'lib', 'queries.ts'), 'utf8');

const stubs = Object.fromEntries(
  [...QUERIES.matchAll(/^export (?:function|const) (\w+)/gm)].map(([, name]) => [
    name,
    (...args: unknown[]) => ({ queryKey: ['stub', name, ...args], enabled: false }),
  ]),
);

mock.module('../src/lib/queries.ts', () => ({
  ...stubs,
  membersQuery: (guildId: string, userIds: readonly string[]) => ({
    queryKey: ['case-evidence', 'members', guildId, ...userIds],
    queryFn: async () => [],
    enabled: userIds.length > 0,
  }),
  channelsQuery: (guildId: string) => ({
    queryKey: ['case-evidence', 'channels', guildId],
    queryFn: async () => [],
  }),
}));

mock.module('../src/server/reports.ts', () => ({
  searchReports: async () => null,
  getReportSummary: async () => null,
  getReport: async () => null,
  listReportAutomationRuns: async () => null,
  getCaseEvidence: async () => null,
  actOnReport: async () => null,
}));

const { CaseEvidence } = await import('../src/pages/cases/evidence.tsx');
const { caseEvidenceQuery } = await import('../src/pages/moderation/reports/queries.ts');

type Message = NonNullable<CaseEvidenceView['proof']>;

function message(overrides: Partial<Message>): Message {
  return {
    caseId: CASE,
    messageId: '600000000000000001',
    channelId: GENERAL,
    authorId: AUTHOR,
    content: '',
    attachments: [],
    createdAt: NOW - 60_000,
    deletedAt: null,
    proof: false,
    capturedAt: NOW - 30_000,
    expiresAt: NOW + 30 * 86_400_000,
    ...overrides,
  };
}

function render(evidence: CaseEvidenceView, createdAt = new Date(NOW - 3_600_000)): string {
  const client = new QueryClient();
  client.setQueryData(caseEvidenceQuery(GUILD, CASE).queryKey, evidence);
  client.setQueryData(
    ['case-evidence', 'members', GUILD, AUTHOR],
    [{ id: AUTHOR, displayName: 'Spammer', username: 'spammer', avatarUrl: null, bot: false }],
  );
  client.setQueryData(
    ['case-evidence', 'channels', GUILD],
    [{ id: GENERAL, name: 'general', type: 0, parentId: null, parentName: null }],
  );

  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <CaseEvidence guildId={GUILD} caseId={CASE} createdAt={createdAt.toISOString()} now={NOW} />
    </QueryClientProvider>,
  );
}

describe('the Case log’s proof and message history', () => {
  test('a case with nothing kept says so and shows no history at all', () => {
    const html = render({ proof: null, history: [] });

    expect(html).toContain('No proof was captured');
    expect(html).not.toContain('Kept 30 days');
    expect(html).not.toContain('Message history');
  });

  test('the proof and the history render as the member’s own messages, with how long they are kept', () => {
    const html = render({
      proof: message({
        messageId: '600000000000000009',
        content: 'buy followers here',
        proof: true,
        deletedAt: NOW - 20_000,
        attachments: [
          {
            id: 'a1',
            filename: 'proof.png',
            contentType: 'image/png',
            size: 2048,
            url: 'https://cdn.discordapp.com/attachments/1/2/proof.png',
            expiresAt: NOW + 86_400_000,
          },
        ],
      }),
      history: [
        message({ messageId: '600000000000000002', content: 'first message' }),
        message({ messageId: '600000000000000003', content: 'second message' }),
      ],
    });

    expect(html).toContain('Proof');
    expect(html).toContain('Message history');
    expect(html.match(/Kept 30 days/g)).toHaveLength(2);
    expect(html).toContain('Spammer');
    expect(html).toContain('#general');
    expect(html).toContain('buy followers here');
    expect(html).toContain('Deleted');
    expect(html).toContain('proof.png');
    expect(html.indexOf('first message')).toBeLessThan(html.indexOf('second message'));
    expect(html).not.toContain('No proof was captured');
  });

  test('a case older than 30 days says its proof ran out, not that none was captured', () => {
    const old = render({ proof: null, history: [] }, new Date(NOW - 45 * 86_400_000));

    expect(old).toContain(
      'Proof and message history are kept 30 days after the case, so none is left for this one.',
    );
    expect(old).not.toContain('No proof was captured');

    const young = render({ proof: null, history: [] }, new Date(NOW - 29 * 86_400_000));
    expect(young).toContain('No proof was captured');
  });

  test('history without proof still shows the history', () => {
    const html = render({ proof: null, history: [message({ content: 'kept anyway' })] });

    expect(html).toContain('No proof was captured');
    expect(html).toContain('Message history');
    expect(html).toContain('kept anyway');
  });

  test('only punishments carry proof, so only their dialog asks for it', () => {
    const log = readFileSync(
      join(import.meta.dir, '..', 'src', 'pages', 'cases', 'log.tsx'),
      'utf8',
    );

    expect(log).toContain('{MARKED.has(row.type) ? (\n        <CaseEvidence');
    expect(log).toContain('createdAt={row.createdAt}');
    expect(log).toContain("const MARKED = new Set<string>(['warn', 'ban', 'kick', 'timeout']);");
  });
});
