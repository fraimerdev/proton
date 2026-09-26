import { describe, expect, test } from 'bun:test';
import { formatCommandLabel, type ProtonEvent } from '@proton/core';
import { specByKey } from '../src/catalogue.ts';
import { ServerLogColors } from '../src/colours.ts';
import { serverlogDefaultConfig } from '../src/config.ts';
import {
  createServerlogListener,
  logIdempotencyKey,
  SERVERLOG_EVENT_TYPES,
} from '../src/listeners.ts';
import {
  BOT_USER,
  config,
  context,
  EMOJIS,
  GUILD,
  LOG_CHANNEL,
  RecordingExecutor,
  resolver,
} from './harness.ts';

const listener = () =>
  createServerlogListener({ emojis: EMOJIS, users: resolver, botUserId: BOT_USER });

const MEMBER = '200000000000000011';
const REPORTER = '200000000000000012';
const MODERATOR = '200000000000000013';
const SOURCE_CHANNEL = '500000000000000031';
const SOURCE_MESSAGE = '600000000000000031';
const MODERATION_CHANNEL = '500000000000000032';
const EVENT_CHANNEL = '500000000000000033';

const SECRETS = [
  'my neighbour posted my address',
  'he keeps DMing slurs',
  'https://cdn.discordapp.com/attachments/1/2/proof.png',
  'reporter-note-text',
  'internal-note-text',
];

function moderationEvent(type: ProtonEvent['type'], naturalKey: string, payload: unknown) {
  return {
    id: `${type}:${GUILD}:${naturalKey}`,
    type,
    guildId: GUILD,
    occurredAt: 1_700_000_000_000,
    payload,
  } satisfies ProtonEvent;
}

const expired = {
  guildId: GUILD,
  caseId: 'Qm4T7zR',
  kind: 'timeout' as const,
  userId: MEMBER,
  endedAt: 1_700_000_300_000,
  memberPresent: true,
};

const submitted = {
  guildId: GUILD,
  reportId: 'Xk3P9aQ',
  number: 12,
  reporterId: REPORTER,
  targetId: MEMBER,
  method: 'message_menu' as const,
  reason: 'Harassment',
  channelId: SOURCE_CHANNEL,
  messageId: SOURCE_MESSAGE,
  createdAt: 1_700_000_000_000,
};

const resolved = {
  guildId: GUILD,
  reportId: 'Xk3P9aQ',
  number: 12,
  targetId: MEMBER,
  reporterId: REPORTER,
  status: 'accepted' as const,
  resolvedBy: MODERATOR,
  actionKind: 'ban',
  caseIds: ['Ab12Cd3'],
  resolvedAt: 1_700_000_600_000,
};

async function render(event: ProtonEvent, cfg = config()) {
  const executor = new RecordingExecutor();
  await listener().handler(event, context(executor, cfg));
  return executor;
}

function body(executor: RecordingExecutor): string {
  return String(executor.embeds()[0]?.description);
}

describe('the listener hears the moderation events', () => {
  test('all three are subscribed, straight from the catalogue', () => {
    expect(SERVERLOG_EVENT_TYPES).toContain('moderation.punishment_expired');
    expect(SERVERLOG_EVENT_TYPES).toContain('moderation.report_submitted');
    expect(SERVERLOG_EVENT_TYPES).toContain('moderation.report_resolved');
  });

  test('each is an immediate moderation log', () => {
    for (const key of [
      'moderation.timeout_expired',
      'moderation.report_filed',
      'moderation.report_resolved',
    ]) {
      expect(specByKey(key)?.category).toBe('moderation');
      expect(specByKey(key)?.primary).toBe('immediate');
    }
  });
});

describe('timeout expired', () => {
  test('names the member, the case and when it ended', async () => {
    const executor = await render(
      moderationEvent('moderation.punishment_expired', expired.caseId, expired),
    );

    expect(executor.titles()).toEqual(['Timeout expired']);
    expect(executor.channels()).toEqual([LOG_CHANNEL]);

    const text = body(executor);
    expect(text).toContain(`<@${MEMBER}>`);
    expect(text).toContain(`\`${MEMBER}\``);
    expect(text).toContain('`Qm4T7zR`');
    expect(text).toContain('**Ended:** <t:1700000300:F>');
    expect(text).not.toContain('Not in the server');
  });

  test('says so when the member has left', async () => {
    const executor = await render(
      moderationEvent('moderation.punishment_expired', expired.caseId, {
        ...expired,
        memberPresent: false,
      }),
    );

    expect(body(executor)).toContain('`Not in the server`');
  });

  test('a payload that fails the core schema posts nothing', async () => {
    const executor = await render(
      moderationEvent('moderation.punishment_expired', expired.caseId, {
        ...expired,
        kind: 'ban',
      }),
    );

    expect(executor.requests).toEqual([]);
  });
});

describe('report filed', () => {
  test('carries the ids, both members, the method, the reason and the source', async () => {
    const executor = await render(
      moderationEvent('moderation.report_submitted', submitted.reportId, submitted),
    );

    expect(executor.titles()).toEqual(['Report #12 filed']);
    expect(executor.embeds()[0]?.color).toBe(ServerLogColors.Add);

    const text = body(executor);
    expect(text).toContain('`Xk3P9aQ`');
    expect(text).toContain('`#12`');
    expect(text).toContain(`**Reported member:** <@${MEMBER}>`);
    expect(text).toContain(`**Reported by:** <@${REPORTER}>`);
    expect(text).toContain('`Apps → Report message`');
    expect(text).toContain('**Reason:** `Harassment`');
    expect(text).toContain(`<#${SOURCE_CHANNEL}>`);
    expect(text).toContain(
      `https://discord.com/channels/${GUILD}/${SOURCE_CHANNEL}/${SOURCE_MESSAGE}`,
    );
  });

  test('a member report has no source lines', async () => {
    const executor = await render(
      moderationEvent('moderation.report_submitted', submitted.reportId, {
        ...submitted,
        method: 'command',
        channelId: null,
        messageId: null,
      }),
    );

    const text = body(executor);
    expect(text).toContain('`/report`');
    expect(text).not.toContain('Source');
    expect(text).not.toContain('Jump');
  });

  test('names the report command and menus as this server has renamed them', async () => {
    const names: Record<string, string> = {
      report: 'flag',
      'user:Report user': 'Flag member',
      'message:Report message': 'Flag message',
    };
    const renamed = (method: 'command' | 'user_menu' | 'message_menu') => {
      const executor = new RecordingExecutor();
      return listener()
        .handler(
          moderationEvent('moderation.report_submitted', `${submitted.reportId}:${method}`, {
            ...submitted,
            method,
          }),
          {
            ...context(executor),
            commandLabel: (key, path) => formatCommandLabel(key, path, names[key]),
          },
        )
        .then(() => body(executor));
    };

    expect(await renamed('command')).toContain('**Method:** `/flag`');
    expect(await renamed('user_menu')).toContain('**Method:** `Apps → Flag member`');
    expect(await renamed('message_menu')).toContain('**Method:** `Apps → Flag message`');
  });

  test('a report by reaction is still named as a reaction', async () => {
    const executor = await render(
      moderationEvent('moderation.report_submitted', submitted.reportId, {
        ...submitted,
        method: 'reaction',
      }),
    );

    expect(body(executor)).toContain('**Method:** `Reaction`');
  });

  test('a reason outside the list is named as such, never quoted', async () => {
    const executor = await render(
      moderationEvent('moderation.report_submitted', submitted.reportId, {
        ...submitted,
        reason: null,
        customReason: SECRETS[1],
      }),
    );

    expect(body(executor)).toContain('**Reason:** `Custom reason or none`');
  });

  test('member-written text and evidence never reach the log', async () => {
    const executor = await render(
      moderationEvent('moderation.report_submitted', submitted.reportId, {
        ...submitted,
        reason: null,
        comment: SECRETS[0],
        customReason: SECRETS[1],
        evidence: { attachments: [{ url: SECRETS[2] }], message: { content: SECRETS[0] } },
        reporterNote: SECRETS[3],
      }),
    );

    const posted = JSON.stringify(executor.requests);
    expect(executor.requests).toHaveLength(1);
    for (const secret of SECRETS) expect(posted).not.toContain(secret);
  });

  test('mentions in the log never ping', async () => {
    const executor = await render(
      moderationEvent('moderation.report_submitted', submitted.reportId, submitted),
    );

    expect(executor.payloads()[0]?.allowedMentions).toEqual({ parse: [] });
  });
});

describe('report resolved', () => {
  test('an accepted report names the moderator, the action and the linked case', async () => {
    const executor = await render(
      moderationEvent('moderation.report_resolved', resolved.reportId, resolved),
    );

    expect(executor.titles()).toEqual(['Report #12 accepted']);
    expect(executor.embeds()[0]?.color).toBe(ServerLogColors.Remove);

    const text = body(executor);
    expect(text).toContain('`Xk3P9aQ`');
    expect(text).toContain('**Status:** `Accepted`');
    expect(text).toContain(`**Resolved by:** <@${MODERATOR}>`);
    expect(text).toContain('**Action:** `ban`');
    expect(text).toContain('**Case:** `Ab12Cd3`');
  });

  test('several cases are all listed', async () => {
    const executor = await render(
      moderationEvent('moderation.report_resolved', resolved.reportId, {
        ...resolved,
        actionKind: 'timeout',
        caseIds: ['Ab12Cd3', 'Ef45Gh6'],
      }),
    );

    expect(body(executor)).toContain('**Cases:** `Ab12Cd3, Ef45Gh6`');
  });

  test('a dismissed report has no action and no case', async () => {
    const executor = await render(
      moderationEvent('moderation.report_resolved', resolved.reportId, {
        ...resolved,
        status: 'dismissed',
        actionKind: null,
        caseIds: [],
      }),
    );

    expect(executor.titles()).toEqual(['Report #12 dismissed']);
    expect(executor.embeds()[0]?.color).toBe(ServerLogColors.Modify);

    const text = body(executor);
    expect(text).toContain('**Status:** `Dismissed`');
    expect(text).toContain('**Action:** `None`');
    expect(text).not.toContain('Case');
  });

  test('notes written at resolution never reach the log', async () => {
    const executor = await render(
      moderationEvent('moderation.report_resolved', resolved.reportId, {
        ...resolved,
        reporterNote: SECRETS[3],
        note: SECRETS[4],
        comment: SECRETS[0],
      }),
    );

    const posted = JSON.stringify(executor.requests);
    expect(executor.requests).toHaveLength(1);
    for (const secret of SECRETS) expect(posted).not.toContain(secret);
  });
});

describe('routing', () => {
  const filed = () => moderationEvent('moderation.report_submitted', submitted.reportId, submitted);

  test('the moderation category channel takes the three logs', async () => {
    const cfg = config({
      categoryChannels: {
        ...serverlogDefaultConfig.categoryChannels,
        moderation: MODERATION_CHANNEL,
      },
    });

    const executor = new RecordingExecutor();
    const ctx = context(executor, cfg);
    await listener().handler(filed(), ctx);
    await listener().handler(
      moderationEvent('moderation.report_resolved', resolved.reportId, resolved),
      ctx,
    );
    await listener().handler(
      moderationEvent('moderation.punishment_expired', expired.caseId, expired),
      ctx,
    );

    expect(executor.channels()).toEqual([
      MODERATION_CHANNEL,
      MODERATION_CHANNEL,
      MODERATION_CHANNEL,
    ]);
  });

  test('the moderation category off silences them', async () => {
    const executor = await render(
      filed(),
      config({ categories: { ...serverlogDefaultConfig.categories, moderation: false } }),
    );

    expect(executor.requests).toEqual([]);
  });

  test('a per-event override beats the category, both ways', async () => {
    const on = await render(
      filed(),
      config({
        categories: { ...serverlogDefaultConfig.categories, moderation: false },
        events: { 'moderation.report_filed': { enabled: true, channelId: EVENT_CHANNEL } },
      }),
    );
    expect(on.channels()).toEqual([EVENT_CHANNEL]);

    const off = await render(
      filed(),
      config({ events: { 'moderation.report_filed': { enabled: false } } }),
    );
    expect(off.requests).toEqual([]);
  });

  test('a redelivered event reuses its idempotency key', async () => {
    const executor = new RecordingExecutor();
    const ctx = context(executor);
    await listener().handler(filed(), ctx);
    await listener().handler(filed(), ctx);

    const key = logIdempotencyKey(GUILD, 'moderation.report_filed', filed().id);
    expect(executor.requests.map((request) => request.idempotencyKey)).toEqual([key, key]);
    expect(executor.requests.every((request) => request.record === false)).toBe(true);
  });
});
