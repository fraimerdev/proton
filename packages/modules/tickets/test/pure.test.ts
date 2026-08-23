import { describe, expect, test } from 'bun:test';
import { Permissions, parseCustomId } from '@proton/core';
import { readActivity, watchesActivity } from '../src/activity.ts';
import { renderOpenList } from '../src/commands.ts';
import {
  CHANNEL_NAME_MAX,
  renderChannelName,
  renderOpeningMessage,
  ticketsConfigSchema,
} from '../src/config.ts';
import { readOpenPress } from '../src/interactions.ts';
import {
  OVERWRITE_MEMBER,
  OVERWRITE_ROLE,
  TICKET_MEMBER_ALLOW,
  ticketOverwrites,
  withoutParticipant,
  withParticipant,
} from '../src/overwrites.ts';
import { buildPanelMessage } from '../src/panel.ts';
import { GUILD, PANEL, SUPPORT_ROLE } from './harness.ts';

const OPENER = '100000000000000001';
const BOT = '300000000000000001';

describe('ticketOverwrites', () => {
  test('denies @everyone through the role whose id is the guild id', () => {
    const overwrites = ticketOverwrites({ guildId: GUILD, openerId: OPENER, panel: PANEL });

    expect(overwrites[0]).toEqual({
      id: GUILD,
      type: OVERWRITE_ROLE,
      deny: Permissions.ViewChannel.toString(),
    });
  });

  test('lets the opener in', () => {
    const overwrites = ticketOverwrites({ guildId: GUILD, openerId: OPENER, panel: PANEL });

    expect(overwrites).toContainEqual({
      id: OPENER,
      type: OVERWRITE_MEMBER,
      allow: TICKET_MEMBER_ALLOW.toString(),
    });
  });

  test('lets every support role in', () => {
    const overwrites = ticketOverwrites({ guildId: GUILD, openerId: OPENER, panel: PANEL });

    expect(overwrites).toContainEqual({
      id: SUPPORT_ROLE,
      type: OVERWRITE_ROLE,
      allow: TICKET_MEMBER_ALLOW.toString(),
    });
  });

  test('never re-adds @everyone as a support role, which would undo the deny', () => {
    const overwrites = ticketOverwrites({
      guildId: GUILD,
      openerId: OPENER,
      panel: { ...PANEL, supportRoleIds: [GUILD, SUPPORT_ROLE] },
    });

    expect(overwrites.filter((entry) => entry.id === GUILD)).toHaveLength(1);
    expect(overwrites.find((entry) => entry.id === GUILD)?.allow).toBeUndefined();
  });

  test('lets the bot itself in when it is told who it is', () => {
    const overwrites = ticketOverwrites({
      guildId: GUILD,
      openerId: OPENER,
      panel: PANEL,
      botUserId: BOT,
    });

    expect(overwrites).toContainEqual({
      id: BOT,
      type: OVERWRITE_MEMBER,
      allow: TICKET_MEMBER_ALLOW.toString(),
    });
  });

  test('an opener who is also the bot is listed once', () => {
    const overwrites = ticketOverwrites({
      guildId: GUILD,
      openerId: BOT,
      panel: PANEL,
      botUserId: BOT,
    });

    expect(overwrites.filter((entry) => entry.id === BOT)).toHaveLength(1);
  });
});

describe('participants', () => {
  const base = ticketOverwrites({ guildId: GUILD, openerId: OPENER, panel: PANEL });

  test('adding somebody grants them the ticket permissions', () => {
    expect(withParticipant(base, '999')).toContainEqual({
      id: '999',
      type: OVERWRITE_MEMBER,
      allow: TICKET_MEMBER_ALLOW.toString(),
    });
  });

  test('adding the same person twice changes nothing', () => {
    const once = withParticipant(base, '999');

    expect(withParticipant(once, '999')).toEqual(once);
  });

  test('removing takes only the member overwrite away, never the role one', () => {
    const removed = withoutParticipant(base, SUPPORT_ROLE);

    expect(removed).toContainEqual({
      id: SUPPORT_ROLE,
      type: OVERWRITE_ROLE,
      allow: TICKET_MEMBER_ALLOW.toString(),
    });
  });
});

describe('renderChannelName', () => {
  test('substitutes the number', () => {
    expect(renderChannelName('ticket-{number}', 12, 'Ada')).toBe('ticket-12');
  });

  test('substitutes the member and lowercases the result', () => {
    expect(renderChannelName('{user}-help', 1, 'Ada')).toBe('ada-help');
  });

  test('replaces characters Discord would strip anyway', () => {
    expect(renderChannelName('{user}!!! help', 1, 'Ada Lovelace')).toBe('ada-lovelace-help');
  });

  test('never leaves a leading or trailing dash', () => {
    expect(renderChannelName('!{user}!', 1, 'Ada')).toBe('ada');
  });

  test('never exceeds the channel name cap', () => {
    expect(renderChannelName('{user}', 1, 'x'.repeat(400))).toHaveLength(CHANNEL_NAME_MAX);
  });
});

describe('renderOpeningMessage', () => {
  test('turns the placeholder into a real mention', () => {
    expect(renderOpeningMessage('{user} opened a ticket.', OPENER)).toBe(
      `<@${OPENER}> opened a ticket.`,
    );
  });
});

describe('buildPanelMessage', () => {
  test('builds one action row with one button', () => {
    const message = buildPanelMessage(PANEL);

    expect(message.ok).toBe(true);
    if (!message.ok) return;

    expect(message.components).toHaveLength(1);
    expect((message.components[0] as { components: unknown[] }).components).toHaveLength(1);
  });

  test('the button custom id decodes back to the panel', () => {
    const message = buildPanelMessage(PANEL);
    if (!message.ok) throw new Error('expected a panel message');

    const button = (message.components[0] as { components: Array<{ custom_id: string }> })
      .components[0];

    expect(readOpenPress(button?.custom_id)).toEqual({ panelId: PANEL.id });
    expect(parseCustomId(button?.custom_id)?.moduleId).toBe('tickets');
  });

  test('refuses a panel id too long to fit in a custom id, and says so', () => {
    const message = buildPanelMessage({ ...PANEL, id: 'p'.repeat(120) });

    expect(message.ok).toBe(false);
    expect(message.ok === false && message.humanReason).toContain('too long');
  });
});

describe('readOpenPress', () => {
  test('ignores another module’s component', () => {
    expect(readOpenPress('proton:rolemenu:open:x')).toBeNull();
  });

  test('ignores a ticket component that is not the open button', () => {
    expect(readOpenPress('proton:tickets:close:x')).toBeNull();
  });

  test('ignores something that is not a Proton custom id at all', () => {
    expect(readOpenPress('some-other-bot-button')).toBeNull();
  });
});

describe('activity', () => {
  test('a guild with no auto-closing panel is not watched at all', () => {
    expect(watchesActivity({ ...ticketsConfigSchema.parse({}), panels: [PANEL] })).toBe(false);
  });

  test('one auto-closing panel is enough to start watching', () => {
    expect(
      watchesActivity({
        ...ticketsConfigSchema.parse({}),
        panels: [{ ...PANEL, autoCloseAfter: '48h' }],
      }),
    ).toBe(true);
  });

  test('reads the channel and whether the author was a bot', () => {
    expect(readActivity({ channel_id: '1', author: { bot: true } })).toEqual({
      channelId: '1',
      isBot: true,
    });
  });

  test('a payload with no channel is unreadable rather than guessed at', () => {
    expect(readActivity({ author: { bot: false } })).toBeNull();
  });
});

describe('renderOpenList', () => {
  test('says there are none rather than showing an empty list', () => {
    expect(renderOpenList([])).toContain('No tickets are open');
  });
});

describe('ticketsConfigSchema', () => {
  test('refuses a name pattern that would give every ticket the same channel name', () => {
    expect(ticketsConfigSchema.safeParse({ namePattern: 'ticket' }).success).toBe(false);
  });

  test('refuses two panels sharing an id', () => {
    const parsed = ticketsConfigSchema.safeParse({
      panels: [
        { id: 'a', channelId: '500000000000000001' },
        { id: 'a', channelId: '500000000000000002' },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  test('defaults leave the module off with no panels', () => {
    const parsed = ticketsConfigSchema.parse({});

    expect(parsed.enabled).toBe(false);
    expect(parsed.panels).toEqual([]);
  });
});
