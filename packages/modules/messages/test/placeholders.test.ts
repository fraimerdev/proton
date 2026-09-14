import { describe, expect, test } from 'bun:test';
import type { ActionRequest, GuildState, Logger, ModuleContext } from '@proton/core';
import {
  type PlaceholderEnvironment,
  SAMPLE_BOT,
  SAMPLE_NOW,
  validateConfigTemplates,
} from '@proton/core/placeholders';
import { type MessagesConfig, messagesConfigSchema } from '../src/config.ts';
import type { MessagesDeps } from '../src/deps.ts';
import { createMessagesModule } from '../src/index.ts';
import {
  MESSAGES_POST_SURFACE,
  MESSAGES_REPLY_SURFACE,
  MESSAGES_SCHEDULED_SURFACE,
  messagesTemplateNotes,
  messagesTemplates,
  renderReply,
} from '../src/placeholders.ts';
import { postKey, runScheduledPost } from '../src/scheduled-post.ts';
import {
  APPLICATION,
  CHANNEL,
  GUILD,
  harness,
  MEMBER,
  OWNER,
  stringOption,
  subcommand,
} from './harness.ts';

const RUN_AT = new Date(SAMPLE_NOW).toISOString();

const SCHEDULE = { channelId: CHANNEL, at: RUN_AT };

function environment(overrides: Partial<PlaceholderEnvironment> = {}): PlaceholderEnvironment {
  return {
    applicationId: APPLICATION,
    bot: async () => ({ ...SAMPLE_BOT, id: APPLICATION }),
    server: async (guildId) => ({ id: guildId, name: 'Proton HQ', memberCount: 1204 }),
    user: async () => null,
    now: () => SAMPLE_NOW,
    ...overrides,
  };
}

function withEnvironment(overrides: Partial<PlaceholderEnvironment> = {}): MessagesDeps {
  return { applicationId: APPLICATION, placeholders: environment(overrides) };
}

function config(templates: unknown[]): MessagesConfig {
  return messagesConfigSchema.parse({ enabled: true, templates });
}

function keysOf(surface: typeof MESSAGES_POST_SURFACE, path: string): string[] {
  return surface.pickerFor(path).map(({ key }) => key);
}

const CONTENT = 'templates.0.content';

const REPLY_PATH = 'templates.0.components.0.buttons.0.action.content';

function withReply(content: string, reply: string, placeholders = true): unknown {
  return {
    name: 'roles',
    placeholders,
    content,
    components: [
      {
        kind: 'buttons',
        buttons: [
          {
            key: 'help',
            style: 'secondary',
            label: 'Help',
            action: { kind: 'reply', content: reply, ephemeral: true },
          },
        ],
      },
    ],
  };
}

describe('the messages surfaces', () => {
  test('a posted template offers the server, Proton, the channel and who ran the command', () => {
    const keys = keysOf(MESSAGES_POST_SURFACE, CONTENT);

    expect(keys).toContain('server.name');
    expect(keys).toContain('bot.mention');
    expect(keys).toContain('destination_channel.mention');
    expect(keys).toContain('actor.mention');
    expect(keys).toContain('actor.nickname');
    expect(keys).toContain('now');
    expect(keys).not.toContain('user.mention');
  });

  test('a scheduled template offers the same, less who ran the command', () => {
    const keys = keysOf(MESSAGES_SCHEDULED_SURFACE, CONTENT);

    expect(keys).toContain('server.name');
    expect(keys).toContain('destination_channel.mention');
    expect(keys).not.toContain('actor.mention');
  });

  test('only a reply offers the member who pressed', () => {
    const keys = keysOf(MESSAGES_REPLY_SURFACE, REPLY_PATH);

    expect(keys).toContain('user.display_name');
    expect(keys).toContain('user.role_mentions');
    expect(keys).toContain('server.name');
    expect(MESSAGES_POST_SURFACE.pickerFor(REPLY_PATH)).toEqual([]);
  });

  test('every surface is seen by anyone in the channel', () => {
    for (const surface of [
      MESSAGES_POST_SURFACE,
      MESSAGES_SCHEDULED_SURFACE,
      MESSAGES_REPLY_SURFACE,
    ]) {
      expect(surface.audience).toBe('public');
    }
  });

  test('the manifest hands the API the same templates the dashboard imports', () => {
    expect(createMessagesModule().templates).toBe(messagesTemplates);
  });

  test('the reply sample renders the sample member', () => {
    const [sample] = MESSAGES_REPLY_SURFACE.samples;
    if (!sample) throw new Error('the reply surface has no sample');

    const lookup = MESSAGES_REPLY_SURFACE.build(sample.facts, { now: SAMPLE_NOW });
    expect(renderReply('Hi {user.display_name}', lookup, SAMPLE_NOW, () => undefined)).toBe(
      'Hi Fraimer',
    );
  });
});

describe('which templates are checked on save', () => {
  test('a template that has not opted in is never collected, so a broken placeholder saves', () => {
    const before = config([{ name: 'rules', content: 'hi' }]);
    const next = config([{ name: 'rules', content: 'Try {bad:mod(' }]);
    const report = validateConfigTemplates(messagesTemplates, next, before);

    expect(messagesTemplates.collect(next)).toEqual([]);
    expect(report.blocking).toEqual([]);
    expect(report.byPath.size).toBe(0);
  });

  test('an opted-in template with a changed broken placeholder blocks, naming the path', () => {
    const before = config([{ name: 'rules', content: 'hi', placeholders: true }]);
    const next = config([{ name: 'rules', content: 'In {server.name:shout}', placeholders: true }]);
    const report = validateConfigTemplates(messagesTemplates, next, before);

    expect(report.blocking).toHaveLength(1);
    expect(report.blocking[0]?.path).toBe(CONTENT);
    expect(report.blocking[0]?.label).toBe('Message text');
  });

  test('switching placeholders on for a template holding {{ warns that doubled braces are literal', () => {
    const before = config([{ name: 'rules', content: 'Write {{ for a brace' }]);
    const next = config([{ name: 'rules', content: 'Write {{ for a brace', placeholders: true }]);
    const report = validateConfigTemplates(messagesTemplates, next, before);

    expect(report.blocking).toEqual([]);
    expect(report.byPath.get(CONTENT)?.map(({ code }) => code)).toContain('doubled_brace_literal');
  });

  test('a reply action is checked against the reply surface, and the message against the post', () => {
    const next = config([withReply('Hi {user.display_name}', 'Thanks {user.display_name}')]);
    const report = validateConfigTemplates(messagesTemplates, next);

    expect(report.byPath.get(CONTENT)?.map(({ code }) => code)).toEqual(['unknown_placeholder']);
    expect(report.byPath.get(REPLY_PATH)).toEqual([]);
  });

  test('collecting never throws on a shape it does not recognise', () => {
    for (const shape of [
      null,
      'templates',
      { templates: 'x' },
      { templates: [null, 1, { placeholders: true }] },
    ]) {
      expect(messagesTemplates.collect(shape)).toEqual([]);
    }
  });
});

describe('a scheduled template and who ran the command', () => {
  test('{actor.mention} in an opted-in scheduled template is a warning, never a block', () => {
    const next = config([
      {
        name: 'news',
        content: 'Posted by {actor.mention}',
        placeholders: true,
        schedule: SCHEDULE,
      },
    ]);

    expect(messagesTemplateNotes(next)).toEqual([
      {
        path: CONTENT,
        label: 'Message text',
        diagnostic: {
          code: 'unavailable',
          severity: 'warning',
          message:
            'Scheduled posts have no one who ran the command, so {actor.mention} is empty there.',
          span: { start: 10, end: 25 },
        },
      },
    ]);
    expect(validateConfigTemplates(messagesTemplates, next).blocking).toEqual([]);
  });

  test('the warning says a fallback is shown when one is given', () => {
    const next = config([
      {
        name: 'news',
        content: 'By {actor.mention:fallback("the team")}',
        placeholders: true,
        schedule: SCHEDULE,
      },
    ]);

    expect(messagesTemplateNotes(next)[0]?.diagnostic.message).toContain(
      'shows its fallback there',
    );
  });

  test('no warning for a template that is not scheduled, or has not opted in', () => {
    const next = config([
      { name: 'posted', content: 'By {actor.mention}', placeholders: true },
      { name: 'literal', content: 'By {actor.mention}', schedule: SCHEDULE },
    ]);

    expect(messagesTemplateNotes(next)).toEqual([]);
  });
});

interface ScheduledLog {
  level: 'info' | 'warn' | 'error';
  message: string;
}

function scheduledContext(templates: unknown[]) {
  const requests: ActionRequest[] = [];
  const logs: ScheduledLog[] = [];
  const bookings: Array<{ runAt: Date; data: unknown }> = [];
  const logger: Logger = {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
  };

  const ctx: ModuleContext<MessagesConfig> = {
    guildId: GUILD,
    config: config(templates),
    executor: {
      execute: async (request) => {
        requests.push(request);
        return { status: 'executed' };
      },
    },
    logger,
    schedule: async (_jobId, runAt, _naturalKey, data) => {
      bookings.push({ runAt, data });
      return { scheduled: true, replaced: false };
    },
  };

  return { ctx, requests, logs, bookings };
}

function logged(logs: readonly ScheduledLog[], level: ScheduledLog['level']): string {
  return logs
    .filter((log) => log.level === level)
    .map(({ message }) => message)
    .join('\n');
}

function postedContent(request: ActionRequest | undefined): string | undefined {
  return (request?.payload as { content?: string } | undefined)?.content;
}

describe('a scheduled post', () => {
  const data = { templateName: 'news', runAt: RUN_AT };
  const later = new Date(SAMPLE_NOW + 3_600_000);
  const unsendable = {
    name: 'news',
    embeds: [{ fields: [{ name: 'Nickname', value: '{actor.nickname}' }] }],
    placeholders: true,
  };

  test('a template that has not opted in posts its braces exactly as written', async () => {
    const { ctx, requests } = scheduledContext([
      { name: 'news', content: 'Welcome to {server} and {server.name}', schedule: SCHEDULE },
    ]);

    await runScheduledPost(data, ctx, later, withEnvironment());

    expect(postedContent(requests[0])).toBe('Welcome to {server} and {server.name}');
  });

  test('an opted-in template fills in the server, uses the booked run as now, and leaves the actor empty', async () => {
    const { ctx, requests } = scheduledContext([
      {
        name: 'news',
        content: 'Update from {server.name}{actor.mention}, {now:unix}',
        placeholders: true,
        schedule: SCHEDULE,
      },
    ]);

    const outcome = await runScheduledPost(data, ctx, later, withEnvironment());

    expect(outcome.action).toBe('posted');
    expect(postedContent(requests[0])).toBe(`Update from Proton HQ, ${SAMPLE_NOW / 1000}`);
    expect(requests[0]?.idempotencyKey).toBe(`messages:${postKey(GUILD, 'news', RUN_AT)}:post`);
  });

  test('an opted-in template that cannot be sent once filled in posts nothing, is not retried, and the log says why', async () => {
    const { ctx, requests, logs, bookings } = scheduledContext([
      { ...unsendable, schedule: SCHEDULE },
    ]);

    const outcome = await runScheduledPost(data, ctx, later, withEnvironment());

    expect(outcome).toEqual({
      action: 'refused',
      reason: expect.stringContaining('embeds.0.fields.0.value'),
      rescheduled: null,
    });
    expect(requests).toHaveLength(0);
    expect(bookings).toHaveLength(0);
    expect(logged(logs, 'error')).toContain('“news” was not posted');
    expect(logged(logs, 'error')).toContain('embeds.0.fields.0.value');
    expect(logged(logs, 'error')).toContain('not retried');
  });

  test('a repeating template that cannot be sent still books its next run', async () => {
    const { ctx, requests, bookings } = scheduledContext([
      { ...unsendable, schedule: { ...SCHEDULE, mode: 'repeat', every: '24h' } },
    ]);
    const next = new Date(SAMPLE_NOW + 86_400_000);

    const outcome = await runScheduledPost(data, ctx, later, withEnvironment());

    expect(outcome).toEqual({
      action: 'refused',
      reason: expect.stringContaining('embeds.0.fields.0.value'),
      rescheduled: next,
    });
    expect(requests).toHaveLength(0);
    expect(bookings).toEqual([
      { runAt: next, data: { templateName: 'news', runAt: next.toISOString() } },
    ]);
  });

  test('a read that keeps failing still posts, with what it could not read left empty', async () => {
    const { ctx, requests, logs } = scheduledContext([
      {
        name: 'news',
        content: 'Update from {server.name}{bot.name}!',
        placeholders: true,
        schedule: SCHEDULE,
      },
    ]);

    const outcome = await runScheduledPost(
      data,
      ctx,
      later,
      withEnvironment({
        server: async () => {
          throw new Error('redis is down');
        },
        bot: async () => {
          throw new Error('rest is down');
        },
      }),
    );

    expect(outcome.action).toBe('posted');
    expect(postedContent(requests[0])).toBe('Update from !');
    expect(logged(logs, 'warn')).toContain("this server's details could not be read");
    expect(logged(logs, 'warn')).toContain('redis is down');
    expect(logged(logs, 'warn')).toContain('rest is down');
  });

  const namesItsChannel = {
    name: 'news',
    content: '{server.name} in #{destination_channel.name}',
    placeholders: true,
    schedule: SCHEDULE,
  };

  function stored(): GuildState {
    return {
      guildId: GUILD,
      ownerId: OWNER,
      everyoneRoleId: GUILD,
      roles: new Map(),
      botRoleIds: [],
      channels: new Map([
        [CHANNEL, { id: CHANNEL, name: 'announcements', type: 0, parentId: null, overwrites: [] }],
      ]),
      name: 'Proton HQ',
      updatedAt: SAMPLE_NOW,
    };
  }

  test('a template naming the server and the channel it posts in reads the server once', async () => {
    const reads = { state: 0, server: 0 };
    const { ctx, requests } = scheduledContext([namesItsChannel]);

    const outcome = await runScheduledPost(data, ctx, later, {
      ...withEnvironment({
        server: async (guildId) => {
          reads.server += 1;
          return { id: guildId, name: 'A name read twice' };
        },
      }),
      guildState: {
        get: async () => {
          reads.state += 1;
          return stored();
        },
      },
    });

    expect(outcome.action).toBe('posted');
    expect(reads).toEqual({ state: 1, server: 0 });
    expect(postedContent(requests[0])).toBe('Proton HQ in #announcements');
  });

  test('when that one read fails, the server and the channel are both left empty', async () => {
    const { ctx, requests, logs } = scheduledContext([namesItsChannel]);

    const outcome = await runScheduledPost(data, ctx, later, {
      ...withEnvironment(),
      guildState: {
        get: async () => {
          throw new Error('redis is down');
        },
      },
    });

    expect(outcome.action).toBe('posted');
    expect(postedContent(requests[0])).toBe('in #');
    expect(logged(logs, 'warn')).toContain("this server's details could not be read");
    expect(logged(logs, 'warn')).toContain('redis is down');
  });
});

describe('/message post with placeholders', () => {
  test('a template that has not opted in posts byte-identical, braces and all', async () => {
    const h = harness();
    const { templates } = config([
      { name: 'rules', content: 'Welcome to {server} — {server.name}' },
    ]);

    await h.run(subcommand('post', [stringOption('name', 'rules')]), {
      templates,
      deps: withEnvironment(),
    });

    expect(h.postedMessage()?.content).toBe('Welcome to {server} — {server.name}');
  });

  test('an opted-in template fills in the server name and who ran the command', async () => {
    const h = harness();
    const { templates } = config([
      {
        name: 'rules',
        content: 'Posted by {actor.mention}{actor.username} in {server.name}',
        placeholders: true,
      },
    ]);

    await h.run(subcommand('post', [stringOption('name', 'rules')]), {
      templates,
      deps: withEnvironment(),
    });

    expect(h.postedMessage()?.content).toBe(`Posted by <@${MEMBER}> in Proton HQ`);
    expect(h.postedMessage()?.allowed_mentions).toEqual({ parse: ['roles', 'users'] });
    expect(h.lastSaid()).toContain('Posted **rules**');
  });

  test('an opted-in template that cannot be sent once filled in is refused, and the member is told where', async () => {
    const h = harness();
    const { templates } = config([
      {
        name: 'rules',
        embeds: [{ fields: [{ name: 'Nickname', value: '{actor.nickname}' }] }],
        placeholders: true,
      },
    ]);

    await h.run(subcommand('post', [stringOption('name', 'rules')]), {
      templates,
      deps: withEnvironment(),
    });

    expect(h.sends()).toHaveLength(0);
    expect(h.lastSaid()).toContain('embeds.0.fields.0.value');
    expect(h.lastSaid()).toContain('Nothing was posted');
  });

  test('a server read that fails still posts, and the log names what could not be read', async () => {
    const h = harness();
    const { templates } = config([
      { name: 'rules', content: 'Welcome to {server.name}!', placeholders: true },
    ]);

    await h.run(subcommand('post', [stringOption('name', 'rules')]), {
      templates,
      deps: withEnvironment({
        server: async () => {
          throw new Error('redis is down');
        },
      }),
    });

    expect(h.postedMessage()?.content).toBe('Welcome to !');
    expect(
      h.logs.some(
        ({ level, message }) =>
          level === 'warn' &&
          message.includes("this server's details could not be read") &&
          message.includes('redis is down'),
      ),
    ).toBe(true);
  });
});
