import { describe, expect, test } from 'bun:test';
import { embedsLength, Permissions, parseCustomId } from '@proton/core';
import { SAMPLE_NOW } from '@proton/core/placeholders';
import { moderationDefaultConfig } from '../src/config.ts';
import {
  buildReportCard,
  cardPings,
  purgedText,
  REPORT_STATUS_COLOURS,
  type ReportCardView,
  toReportCardMessage,
} from '../src/reports/card.ts';
import { canReadHistory, captureLinks } from '../src/reports/evidence.ts';
import { evidenceEmbeds } from '../src/reports/interactions.ts';
import {
  REPORT_ACCEPTED_SURFACE,
  REPORT_DISMISSED_SURFACE,
  REPORT_SUBMITTED_SURFACE,
  renderReportNotice,
} from '../src/reports/surfaces.ts';
import type { ReportRecord } from '../src/reports/types.ts';
import { BOT, GUILD, MEMBER, MODERATOR, REPORTER } from './harness.ts';
import { snapshotOf } from './reports-review-setup.ts';
import { NOW, reportsState } from './reports-setup.ts';

const NOTIFY_ROLE = '410000000000000031';
const DAY = 86_400_000;

function record(overrides: Partial<ReportRecord> = {}): ReportRecord {
  return {
    id: 'Rk3P9aQ',
    guildId: GUILD,
    number: 7,
    reporterId: REPORTER,
    targetId: MEMBER,
    method: 'message_menu',
    status: 'open',
    reasonId: 'spam',
    reason: 'Spam or flooding',
    customReason: null,
    comment: 'Keeps posting the same link.',
    sourceChannelId: '500000000000000001',
    sourceMessageId: '1400000000000000001',
    sourceAuthorId: MEMBER,
    evidence: {
      message: { status: 'captured', snapshot: snapshotOf() },
      links: [],
      attachments: [],
    },
    evidenceExpiresAt: null,
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
      state: 'pending',
      error: null,
      attempts: 0,
      version: 0,
    },
    close: { action: null, dueAt: null, closedAt: null, attempts: 0, error: null },
    decision: { token: null, kind: null, startedAt: null },
    notifications: {},
    dmChannelId: null,
    dmAttempts: 0,
    version: 0,
    idempotencyKey: 'interaction:1',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function view(report: ReportRecord, extra: Partial<ReportCardView> = {}): ReportCardView {
  return {
    report,
    target: { username: 'member', membership: 'member', joinedAt: NOW - 86_400_000 },
    stats: { total: 3, distinctReporters: 2, open: 2 },
    statsWindowDays: 30,
    notifyRoleIds: [NOTIFY_ROLE],
    firstPost: false,
    ...extra,
  };
}

function field(card: ReturnType<typeof buildReportCard>, name: string): string | undefined {
  return card.embeds[0]?.fields?.find((entry) => entry.name === name)?.value;
}

function keys(card: ReturnType<typeof buildReportCard>): string[][] {
  return card.components.map((row) =>
    row.kind === 'buttons' ? row.buttons.map((button) => button.key) : [row.select.key],
  );
}

describe('buildReportCard', () => {
  test('an open message report shows every section and both button rows', () => {
    const card = buildReportCard(view(record()));
    const embed = card.embeds[0];

    expect(embed?.title).toBe('Report `Rk3P9aQ` · #7');
    expect(embed?.color).toBe(REPORT_STATUS_COLOURS.open);
    expect(embed?.footer?.text).toBe('Submitted via Report message');
    expect(field(card, 'Reported member')).toContain(`<@${MEMBER}> · @member · \`${MEMBER}\``);
    expect(field(card, 'Reported member')).toContain('Account created <t:');
    expect(field(card, 'Reported member')).toContain('Joined <t:');
    expect(field(card, 'Reported by')).toBe(`<@${REPORTER}>`);
    expect(field(card, 'Reason')).toBe('Spam or flooding');
    expect(field(card, 'Source')).toContain('[Jump to message](https://discord.com/channels/');
    expect(field(card, 'Message')).toBe('```\nfree nitro at scam.example\n```');
    expect(field(card, 'History')).toBe('Reported 3 times by 2 members in 30 days · 1 other open');
    expect(field(card, 'Status')).toBe('Open · Waiting for staff');
    expect(keys(card)).toEqual([
      ['rclaim', 'raccept', 'rdismiss'],
      ['rmember', 'revidence'],
    ]);
  });

  test('member-written text is fenced with its backticks neutralised', () => {
    const card = buildReportCard(
      view(
        record({
          comment: 'look ```@everyone``` and `code` <@&1> [x](https://evil.example)',
          customReason: 'he said `hi`',
        }),
      ),
    );

    const details = field(card, 'Details') ?? '';
    expect(details.startsWith('```\n')).toBe(true);
    expect(details.endsWith('\n```')).toBe(true);
    expect(details.slice(4, -4)).not.toContain('`');
    expect(field(card, 'Reason')).toBe("Spam or flooding\n```\nhe said 'hi'\n```");
  });

  test('long details and messages are clipped, and the message points at View evidence', () => {
    const card = buildReportCard(
      view(
        record({
          comment: 'a'.repeat(1000),
          evidence: {
            message: { status: 'captured', snapshot: snapshotOf({ content: 'b'.repeat(4000) }) },
            links: [],
            attachments: [],
          },
        }),
      ),
    );

    const details = field(card, 'Details') ?? '';
    expect(details.length).toBeLessThanOrEqual(900 + 8);
    expect(details).toContain('…');

    const message = field(card, 'Message') ?? '';
    expect(message).toContain('Full text under **View evidence**.');
    expect(message.split('\n')[1]?.length).toBeLessThanOrEqual(400);
  });

  test('a card carrying the largest inputs stays inside Discord’s embed limits', () => {
    const card = buildReportCard(
      view(
        record({
          comment: 'c'.repeat(1000),
          customReason: 'r'.repeat(200),
          evidence: {
            message: { status: 'captured', snapshot: snapshotOf({ content: 'm'.repeat(4000) }) },
            links: [],
            attachments: [],
          },
        }),
      ),
    );

    expect(embedsLength(card.embeds)).toBeLessThan(6000);
    for (const entry of card.embeds[0]?.fields ?? []) {
      expect(entry.value.length).toBeLessThanOrEqual(1024);
    }
  });

  test('rows follow the report state', () => {
    const claimed = buildReportCard(view(record({ status: 'in_review', assigneeId: MODERATOR })));
    expect(keys(claimed)[0]).toEqual(['runclaim', 'raccept', 'rdismiss']);
    expect(field(claimed, 'Status')).toBe(`In review · Claimed by <@${MODERATOR}>`);
    expect(claimed.embeds[0]?.color).toBe(REPORT_STATUS_COLOURS.in_review);

    const accepted = buildReportCard(
      view(
        record({
          status: 'accepted',
          resolvedBy: MODERATOR,
          actionKind: 'ban',
          caseIds: ['Kcase01'],
        }),
      ),
    );
    expect(keys(accepted)).toEqual([['rmember', 'revidence']]);
    expect(field(accepted, 'Status')).toBe(`Accepted by <@${MODERATOR}> · Ban · Case \`Kcase01\``);

    const dismissed = buildReportCard(view(record({ status: 'dismissed', resolvedBy: MODERATOR })));
    expect(keys(dismissed)).toEqual([['rmember', 'revidence']]);
    expect(field(dismissed, 'Status')).toBe(`Dismissed by <@${MODERATOR}>`);
    expect(dismissed.embeds[0]?.color).toBe(REPORT_STATUS_COLOURS.dismissed);
  });

  test('the evidence line says what there is, what is missing and what was purged', () => {
    const unavailable = buildReportCard(
      view(
        record({
          evidence: {
            message: {
              status: 'unavailable',
              reason: 'deleted',
              ids: { channelId: '500000000000000001', messageId: '1400000000000000001' },
            },
            links: [{ url: 'https://discord.com/channels/1/2/3', status: 'not_found' }],
            attachments: [
              {
                id: '1',
                filename: 'shot.png',
                contentType: 'image/png',
                size: 1,
                url: 'https://cdn.discordapp.com/x',
                expiresAt: null,
              },
            ],
            copy: { failed: 'no' },
          },
        }),
      ),
    );
    expect(field(unavailable, 'Evidence')).toBe(
      'Message unavailable when reported · 1 attachment · 1 linked message · no copy (see ' +
        '**View evidence**)',
    );
    expect(field(unavailable, 'Message')).toBeUndefined();

    const copied = buildReportCard(
      view(
        record({
          evidence: {
            message: { status: 'captured', snapshot: snapshotOf() },
            links: [],
            attachments: [],
            copy: { channelId: '500000000000000009', messageId: '1500000000000000001' },
          },
        }),
      ),
    );
    expect(field(copied, 'Evidence')).toBe('copy posted below');

    const purged = buildReportCard(
      view(
        record({ evidencePurgedAt: NOW, evidence: { purged: true, links: [], attachments: [] } }),
      ),
    );
    expect(field(purged, 'Evidence')).toBe(
      'Evidence was removed 90 days after the report was filed.',
    );
    expect(field(purged, 'Details')).toBeUndefined();
  });

  test('the purge line says which retention ended', () => {
    const filed = NOW - 200 * DAY;

    expect(
      purgedText({ createdAt: filed, resolvedAt: null, evidencePurgedAt: filed + 90 * DAY }),
    ).toBe('Evidence was removed 90 days after the report was filed.');
    expect(
      purgedText({
        createdAt: filed,
        resolvedAt: filed + 10 * DAY,
        evidencePurgedAt: filed + 40 * DAY,
      }),
    ).toBe('Evidence was removed 30 days after the report was resolved.');
    expect(
      purgedText({
        createdAt: filed,
        resolvedAt: filed + 70 * DAY,
        evidencePurgedAt: filed + 90 * DAY,
      }),
    ).toBe('Evidence was removed 90 days after the report was filed.');
    expect(
      purgedText({
        createdAt: filed,
        resolvedAt: filed + 95 * DAY,
        evidencePurgedAt: filed + 90 * DAY,
      }),
    ).toBe('Evidence was removed 90 days after the report was filed.');
  });

  test('a member report has no source or message section and says when they left', () => {
    const card = buildReportCard(
      view(
        record({
          method: 'command',
          sourceChannelId: null,
          sourceMessageId: null,
          evidence: { links: [], attachments: [] },
        }),
        { target: { username: null, membership: 'absent', joinedAt: null }, stats: null },
      ),
    );

    expect(field(card, 'Source')).toBeUndefined();
    expect(field(card, 'Message')).toBeUndefined();
    expect(field(card, 'History')).toBeUndefined();
    expect(field(card, 'Reported member')).toContain('Not in the server');
    expect(card.embeds[0]?.footer?.text).toBe('Submitted via /report');
  });
});

describe('toReportCardMessage', () => {
  test('buttons carry the report id and only the first post pings, and only the notify roles', () => {
    const first = view(record(), { firstPost: true });
    const body = toReportCardMessage(buildReportCard(first), 'Rk3P9aQ', cardPings(first));

    expect(body.content).toBe(`<@&${NOTIFY_ROLE}>`);
    expect(body.allowedMentions).toEqual({ parse: [], roles: [NOTIFY_ROLE] });

    const ids = (body.components ?? []).flatMap((row) =>
      (row.components ?? []).map((component) => parseCustomId(component.custom_id)),
    );
    expect(ids.map((id) => [id?.moduleId, id?.action, id?.args[0]])).toEqual([
      ['moderation', 'rclaim', 'Rk3P9aQ'],
      ['moderation', 'raccept', 'Rk3P9aQ'],
      ['moderation', 'rdismiss', 'Rk3P9aQ'],
      ['moderation', 'rmember', 'Rk3P9aQ'],
      ['moderation', 'revidence', 'Rk3P9aQ'],
    ]);

    const later = view(record());
    const edit = toReportCardMessage(buildReportCard(later), 'Rk3P9aQ', cardPings(later));
    expect(edit.content).toBeUndefined();
    expect(edit.allowedMentions).toEqual({ parse: [] });
  });
});

describe('evidenceEmbeds', () => {
  const HOUR = 3_600_000;

  function attachment(id: string, filename: string, expiresAt: number | null) {
    return {
      id,
      filename,
      contentType: 'image/png',
      size: 10,
      url: `https://cdn.discordapp.com/attachments/1/${id}/${filename}`,
      expiresAt,
    };
  }

  test('files carry their link expiry, and expired links are not linked', () => {
    const report = record({
      evidence: {
        message: {
          status: 'captured',
          snapshot: snapshotOf({ attachments: [attachment('11', 'proof.png', NOW + HOUR)] }),
        },
        links: [
          { url: 'https://discord.com/channels/1/2/3', status: 'other_server' },
          { url: 'see [here](https://evil.example)', status: 'invalid' },
        ],
        attachments: [attachment('12', 'old](https://evil.example).png', NOW - HOUR)],
        copy: { channelId: '500000000000000009', messageId: '1500000000000000001' },
      },
    });

    const text = JSON.stringify(evidenceEmbeds(report, () => true, NOW));

    expect(text).toContain('[proof.png](https://cdn.discordapp.com/attachments/1/11/proof.png)');
    expect(text).toContain(`link expires <t:${Math.floor((NOW + HOUR) / 1000)}:R>`);
    expect(text).toContain('link expired');
    expect(text).not.toContain('old](https://evil.example)');
    expect(text).toContain('```\\nsee [here](https://evil.example)\\n```');
    expect(text).toContain('In another server, so Proton didn’t read it.');
    expect(text).toContain('Jump to the copy');
    expect(text).toContain('free nitro at scam.example');
  });

  test('embed titles and sticker names cannot turn into masked links', () => {
    const report = record({
      evidence: {
        message: {
          status: 'captured',
          snapshot: snapshotOf({
            embeds: [
              {
                title: '[Discord Staff: verify](https://evil.example/login)',
                description: null,
                url: null,
              },
            ],
            stickers: ['[free](https://evil.example/nitro)'],
          }),
        },
        links: [],
        attachments: [],
      },
    });

    const extras = evidenceEmbeds(report, () => true, NOW)[0]?.fields?.find(
      (entry) => entry.name === 'Also in the message',
    )?.value;

    expect(extras).toBe(
      'Embed: _Discord Staff: verify__https://evil.example/login_\n' +
        'Sticker: _free__https://evil.example/nitro_',
    );
  });

  test('hidden channels, purged evidence and member reports each say so', () => {
    const hidden = JSON.stringify(evidenceEmbeds(record(), () => false, NOW));
    expect(hidden).toContain('Message in a channel you can’t view.');
    expect(hidden).not.toContain('free nitro');

    const purged = evidenceEmbeds(
      record({ evidencePurgedAt: NOW, evidence: { purged: true, links: [], attachments: [] } }),
      () => true,
      NOW,
    );
    expect(purged[0]?.description).toBe('Evidence was removed 90 days after the report was filed.');

    const resolvedEarly = evidenceEmbeds(
      record({
        status: 'dismissed',
        resolvedAt: NOW - 40 * DAY,
        createdAt: NOW - 41 * DAY,
        evidencePurgedAt: NOW,
        evidence: { purged: true, links: [], attachments: [] },
      }),
      () => true,
      NOW,
    );
    expect(resolvedEarly[0]?.description).toBe(
      'Evidence was removed 30 days after the report was resolved.',
    );

    const empty = evidenceEmbeds(
      record({
        sourceChannelId: null,
        sourceMessageId: null,
        evidence: { links: [], attachments: [] },
      }),
      () => true,
      NOW,
    );
    expect(empty[0]?.description).toBe('No message, links or files were attached to this report.');
  });

  test('the longest evidence still fits in one Discord message', () => {
    const report = record({
      evidence: {
        message: {
          status: 'captured',
          snapshot: snapshotOf({
            content: 'x'.repeat(4000),
            attachments: Array.from({ length: 10 }, (_, n) =>
              attachment(`2${n}`, `file-${n}.png`, NOW + HOUR),
            ),
          }),
        },
        links: Array.from({ length: 3 }, (_, n) => ({
          url: `https://discord.com/channels/${GUILD}/500000000000000001/14000000000000000${n}0`,
          status: 'captured' as const,
          snapshot: snapshotOf({ content: 'y'.repeat(4000) }),
        })),
        attachments: Array.from({ length: 10 }, (_, n) =>
          attachment(`3${n}`, `upload-${n}.png`, NOW + HOUR),
        ),
        copy: { failed: 'z'.repeat(300) },
      },
    });

    const embeds = evidenceEmbeds(report, () => true, NOW);
    const total = embeds.reduce(
      (sum, embed) =>
        sum +
        (embed.title?.length ?? 0) +
        (embed.description?.length ?? 0) +
        (embed.fields ?? []).reduce(
          (fields, entry) => fields + entry.name.length + entry.value.length,
          0,
        ),
      0,
    );

    expect(total).toBeLessThanOrEqual(6000);
    for (const embed of embeds) {
      expect(embed.description?.length ?? 0).toBeLessThanOrEqual(4096);
      for (const entry of embed.fields ?? []) expect(entry.value.length).toBeLessThanOrEqual(1024);
    }
  });
});

describe('who may read a channel’s history', () => {
  const PARENT = '500000000000000031';
  const PRIVATE_THREAD = '500000000000000032';
  const PUBLIC_THREAD = '500000000000000033';
  const THREAD_KEEPER = '410000000000000077';

  function state() {
    const built = reportsState();
    built.channels.set(PARENT, { id: PARENT, parentId: null, overwrites: [] });
    built.channels.set(PRIVATE_THREAD, {
      id: PRIVATE_THREAD,
      parentId: PARENT,
      type: 12,
      overwrites: [],
    });
    built.channels.set(PUBLIC_THREAD, {
      id: PUBLIC_THREAD,
      parentId: PARENT,
      type: 11,
      overwrites: [],
    });
    built.roles.set(THREAD_KEEPER, {
      id: THREAD_KEEPER,
      permissions: Permissions.ManageThreads,
      position: 5,
    });
    return built;
  }

  test('a private thread needs Manage Threads on top of reading its parent', () => {
    const guild = state();

    expect(canReadHistory(guild, REPORTER, [], PARENT)).toBe(true);
    expect(canReadHistory(guild, REPORTER, [], PUBLIC_THREAD)).toBe(true);
    expect(canReadHistory(guild, REPORTER, [], PRIVATE_THREAD)).toBe(false);
    expect(canReadHistory(guild, REPORTER, [THREAD_KEEPER], PRIVATE_THREAD)).toBe(true);
    expect(canReadHistory(guild, guild.ownerId, [], PRIVATE_THREAD)).toBe(true);
  });

  test('Proton’s own access to a private thread is left to Discord', () => {
    expect(canReadHistory(state(), BOT, [], PRIVATE_THREAD, { bot: true })).toBe(true);
  });

  test('a reporter who cannot open a private thread gets no link captured from it', async () => {
    const reads: string[] = [];
    const links = await captureLinks({
      guildId: GUILD,
      reporterId: REPORTER,
      reporterRoleIds: [],
      lines: [`https://discord.com/channels/${GUILD}/${PRIVATE_THREAD}/1400000000000000555`],
      state: state(),
      readMessage: async (_guildId, channelId, messageId) => {
        reads.push(`${channelId}:${messageId}`);
        return { ok: false, reason: 'not_found' };
      },
    });

    expect(links.map((link) => link.status)).toEqual(['no_access']);
    expect(reads).toEqual([]);
  });
});

describe('reporter notice surfaces', () => {
  test('staff-only keys never render into a reporter DM', () => {
    const message = moderationDefaultConfig.reports.notifications.dismissed.message;
    const facts = REPORT_DISMISSED_SURFACE.samples[0]?.facts;
    if (!facts) throw new Error('no sample');

    const leaking = {
      ...message,
      embeds: [{ description: 'note: {report.internal_note} cases: {report.case_ids}' }],
    };
    const rendered = renderReportNotice('dismissed', leaking, facts, SAMPLE_NOW);
    const text = rendered.ok ? JSON.stringify(rendered.message) : '';

    expect(text).not.toContain('Second report this week');
    expect(text).not.toContain('K7f3M2q');
  });

  test('each surface renders its default message from its sample', () => {
    for (const [kind, surface] of [
      ['submitted', REPORT_SUBMITTED_SURFACE],
      ['accepted', REPORT_ACCEPTED_SURFACE],
      ['dismissed', REPORT_DISMISSED_SURFACE],
    ] as const) {
      const facts = surface.samples[0]?.facts;
      if (!facts) throw new Error('no sample');

      const rendered = renderReportNotice(
        kind,
        moderationDefaultConfig.reports.notifications[kind].message,
        facts,
        SAMPLE_NOW,
      );
      expect(rendered.ok).toBe(true);
      expect(JSON.stringify(rendered.ok ? rendered.message : null)).toContain('Rk3P9aQ');
    }
  });

  test('the explanation reaches the dismissed DM and the action the accepted one', () => {
    const facts = REPORT_DISMISSED_SURFACE.samples[0]?.facts;
    const acceptedFacts = REPORT_ACCEPTED_SURFACE.samples[0]?.facts;
    if (!facts || !acceptedFacts) throw new Error('no sample');

    const base = moderationDefaultConfig.reports.notifications.dismissed.message;
    const dismissed = renderReportNotice(
      'dismissed',
      { ...base, embeds: [{ description: 'Staff said: {report.explanation}' }] },
      facts,
      SAMPLE_NOW,
    );
    expect(JSON.stringify(dismissed.ok ? dismissed.message : null)).toContain(
      'a joke between friends',
    );

    const accepted = renderReportNotice(
      'accepted',
      { ...base, embeds: [{ description: 'Outcome: {report.action}' }] },
      acceptedFacts,
      SAMPLE_NOW,
    );
    expect(JSON.stringify(accepted.ok ? accepted.message : null)).toContain('Outcome: Ban');
  });

  test('the default messages carry the note from staff as its own field', () => {
    for (const [kind, surface] of [
      ['accepted', REPORT_ACCEPTED_SURFACE],
      ['dismissed', REPORT_DISMISSED_SURFACE],
    ] as const) {
      const sample = surface.samples[0]?.facts;
      if (!sample) throw new Error('no sample');
      const facts = {
        ...sample,
        report: { ...sample.report, explanation: 'Thanks — *we* handled <@1> it.' },
      };

      const rendered = renderReportNotice(
        kind,
        moderationDefaultConfig.reports.notifications[kind].message,
        facts,
        SAMPLE_NOW,
      );
      if (!rendered.ok) throw new Error(rendered.humanReason);

      const fields = rendered.message.embeds[0]?.fields ?? [];
      expect(fields.at(-1)).toEqual({
        name: 'Note from staff',
        value: 'Thanks — \\*we\\* handled \\<@1\\> it.',
        inline: false,
      });
    }
  });

  test('no note, a message that places it, or a received message add nothing', () => {
    const sample = REPORT_DISMISSED_SURFACE.samples[0]?.facts;
    if (!sample) throw new Error('no sample');
    const message = moderationDefaultConfig.reports.notifications.dismissed.message;

    const silent = renderReportNotice(
      'dismissed',
      message,
      { ...sample, report: { ...sample.report, explanation: '   ' } },
      SAMPLE_NOW,
    );
    expect(JSON.stringify(silent.ok ? silent.message : null)).not.toContain('Note from staff');

    const placed = renderReportNotice(
      'dismissed',
      { ...message, embeds: [{ description: 'Staff said: {report.explanation}' }] },
      sample,
      SAMPLE_NOW,
    );
    expect(JSON.stringify(placed.ok ? placed.message : null)).not.toContain('Note from staff');

    const received = renderReportNotice(
      'submitted',
      moderationDefaultConfig.reports.notifications.submitted.message,
      { ...sample, report: { ...sample.report, status: 'open', explanation: 'hello' } },
      SAMPLE_NOW,
    );
    expect(JSON.stringify(received.ok ? received.message : null)).not.toContain('hello');
  });

  test('without an embed the note is a line of content, and a v2 layout gets a text block', () => {
    const sample = REPORT_ACCEPTED_SURFACE.samples[0]?.facts;
    if (!sample) throw new Error('no sample');
    const base = moderationDefaultConfig.reports.notifications.accepted.message;

    const plain = renderReportNotice(
      'accepted',
      { ...base, content: 'Report {report.id} was accepted.', embeds: [] },
      sample,
      SAMPLE_NOW,
    );
    expect(plain.ok ? plain.message.content : null).toBe(
      'Report Rk3P9aQ was accepted.\n\n**Note from staff:** Thanks for flagging it. They won’t be back.',
    );

    const layout = renderReportNotice(
      'accepted',
      { ...base, embeds: [], v2: [{ kind: 'text', content: 'Report {report.id} was accepted.' }] },
      sample,
      SAMPLE_NOW,
    );
    expect(layout.ok ? layout.message.v2.at(-1) : null).toEqual({
      kind: 'text',
      content: '**Note from staff**\nThanks for flagging it. They won’t be back.',
    });
  });
});
