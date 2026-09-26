import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

const GUILD = '900000000000000002';
const GENERAL = '500000000000000001';
const AUTHOR = '400000000000000002';
const NOW = Date.parse('2026-09-18T14:00:00.000Z');
const HOUR = 3_600_000;

const QUERIES = readFileSync(join(import.meta.dir, '..', 'src', 'lib', 'queries.ts'), 'utf8');

const stubs = Object.fromEntries(
  [...QUERIES.matchAll(/^export (?:function|const) (\w+)/gm)].map(([, name]) => [
    name,
    (...args: unknown[]) => ({ queryKey: ['stub', name, ...args], enabled: false }),
  ]),
);

mock.module('../src/lib/queries.ts', () => ({ ...stubs, MEMBER_LOOKUP_MAX: 100 }));

const { EvidenceSection } = await import('../src/pages/moderation/reports/evidence.tsx');

type Report = Parameters<typeof EvidenceSection>[0]['report'];

const SNAPSHOT = {
  id: '600000000000000001',
  channelId: GENERAL,
  authorId: AUTHOR,
  authorName: 'riley',
  authorBot: false,
  url: `https://discord.com/channels/${GUILD}/${GENERAL}/600000000000000001`,
  createdAt: NOW - HOUR,
  editedAt: null,
  content: 'you are **all** getting banned',
  attachments: [
    {
      id: 'a1',
      filename: 'proof.png',
      contentType: 'image/png',
      size: 20_480,
      url: 'https://cdn.discordapp.com/attachments/1/2/proof.png?ex=1',
      expiresAt: NOW + 5 * HOUR,
    },
    {
      id: 'a2',
      filename: 'old.txt',
      contentType: 'text/plain',
      size: 12,
      url: 'https://cdn.discordapp.com/attachments/1/3/old.txt?ex=1',
      expiresAt: NOW - HOUR,
    },
  ],
  embeds: [],
  stickers: [],
  forwarded: false,
  forwardedContent: null,
  capturedFrom: 'interaction' as const,
};

function report(overrides: Partial<Report> = {}): Report {
  return {
    evidence: { links: [], attachments: [] },
    evidencePurgedAt: null,
    evidenceExpiresAt: NOW + 30 * 86_400_000,
    createdAt: NOW - 40 * 86_400_000,
    resolvedAt: null,
    ...overrides,
  };
}

function render(value: Report, mentionNames?: ReadonlyMap<string, string>): string {
  return renderToStaticMarkup(
    <EvidenceSection
      guildId={GUILD}
      report={value}
      now={NOW}
      channelName={(id) => (id === GENERAL ? 'general' : undefined)}
      mentionNames={mentionNames}
    />,
  );
}

describe('report evidence', () => {
  test('a captured message is drawn as the member wrote it, not as Proton', () => {
    const markup = render(
      report({
        evidence: {
          message: { status: 'captured', snapshot: SNAPSHOT },
          links: [],
          attachments: [],
        },
      }),
    );

    expect(markup).toContain('<span class="dc-author">riley</span>');
    expect(markup).not.toContain('dc-bot-tag');
    expect(markup).toContain('<strong>all</strong>');
    expect(markup).toContain('#general');
    expect(markup).toContain(`href="${SNAPSHOT.url}"`);
    expect(markup).toContain('Jump to message');
  });

  test('attachments are Discord links with an expiry, never presented as kept files', () => {
    const markup = render(
      report({
        evidence: {
          message: { status: 'captured', snapshot: SNAPSHOT },
          links: [],
          attachments: [],
        },
      }),
    );

    expect(markup).toContain('proof.png');
    expect(markup).toContain('20 KB');
    expect(markup).toContain('Link from Discord, expires in 5h');
    expect(markup).toContain('href="https://cdn.discordapp.com/attachments/1/2/proof.png?ex=1"');

    expect(markup).toContain('old.txt');
    expect(markup).toContain('Link expired');
    expect(markup).not.toContain('old.txt?ex=1');
  });

  test('a message Proton could not read says so', () => {
    const markup = render(
      report({
        evidence: {
          message: {
            status: 'unavailable',
            reason: 'deleted',
            ids: { channelId: GENERAL, messageId: '600000000000000009' },
          },
          links: [],
          attachments: [],
        },
      }),
    );

    expect(markup).toContain('Message unavailable when reported');
    expect(markup).toContain('The message was deleted before Proton could read it.');
  });

  test('purged evidence says when it went, and promises no retention date', () => {
    const markup = render(
      report({
        evidence: { links: [], attachments: [], purged: true },
        evidencePurgedAt: NOW,
        resolvedAt: NOW - 31 * 86_400_000,
      }),
    );

    expect(markup).toContain('Evidence was removed 30 days after this report was resolved.');
    expect(markup).not.toContain('Kept until');
  });

  test('only Discord message links become links; anything else a reporter typed stays text', () => {
    const markup = render(
      report({
        evidence: {
          links: [
            { url: 'https://evil.example/login', status: 'invalid' },
            {
              url: `https://discord.com/channels/${GUILD}/${GENERAL}/600000000000000002`,
              status: 'no_access',
            },
          ],
          attachments: [],
        },
      }),
    );

    expect(markup).toContain('Not captured: not a message link');
    expect(markup).not.toContain('href="https://evil.example/login"');
    expect(markup).toContain('Not captured: the reporter can’t view that channel');
    expect(markup).toContain(
      `href="https://discord.com/channels/${GUILD}/${GENERAL}/600000000000000002"`,
    );
  });

  test('a copy Proton could not forward carries its reason', () => {
    const markup = render(
      report({
        evidence: {
          links: [],
          attachments: [],
          copy: { failed: 'Discord refused to forward it: polls can’t be forwarded.' },
        },
      }),
    );

    expect(markup).toContain(
      'Proton didn’t forward a copy: Discord refused to forward it: polls can’t be forwarded.',
    );
  });

  test('a forwarding failure names the channel instead of printing Discord markup', () => {
    const markup = render(
      report({
        evidence: {
          links: [],
          attachments: [],
          copy: {
            failed: `Proton needs View Channel and Read Message History in <#${GENERAL}> to forward it.`,
          },
        },
      }),
      new Map([[GENERAL, 'general']]),
    );

    expect(markup).toContain('Read Message History in #general to forward it.');
    expect(markup).not.toContain(`&lt;#${GENERAL}&gt;`);
  });

  test('evidence purged while the report was still open blames the 90-day clock', () => {
    const markup = render(
      report({
        evidence: { links: [], attachments: [], purged: true },
        createdAt: NOW - 100 * 86_400_000,
        evidencePurgedAt: NOW - 10 * 86_400_000,
        resolvedAt: NOW - 5 * 86_400_000,
      }),
    );

    expect(markup).toContain('Evidence was removed 90 days after this report was filed.');
  });

  test('a report with nothing attached says so', () => {
    expect(render(report())).toContain('No message, links or files came with this report.');
  });
});
