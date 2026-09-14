import { describe, expect, test } from 'bun:test';
import { MESSAGE_CONTENT_MAX, NICKNAME_MAX } from '@proton/core';
import { RECAP_MAX } from '../src/config.ts';
import {
  displayName,
  formatElapsed,
  isTagged,
  nicknameProblem,
  renderNotice,
  renderRecap,
  renderWelcome,
  tagNickname,
  untagged,
} from '../src/render.ts';
import type { AfkPing } from '../src/store.ts';

const GUILD = '900000000000000001';
const SINCE = new Date('2026-09-13T10:00:00.000Z');
const SINCE_TAG = `<t:${Math.floor(SINCE.getTime() / 1000)}:R>`;

describe('tagNickname', () => {
  test('puts [AFK] in front of the name', () => {
    expect(tagNickname('Bob')).toBe('[AFK] Bob');
  });

  test('stays within Discord’s 32 characters', () => {
    const tagged = tagNickname('x'.repeat(40));

    expect(tagged).toHaveLength(NICKNAME_MAX);
    expect(tagged.startsWith('[AFK] ')).toBe(true);
  });

  test('never cuts an emoji in half at the limit', () => {
    expect(tagNickname(`${'x'.repeat(25)}😴😴`)).toBe(`[AFK] ${'x'.repeat(25)}`);
  });

  test('keeps a flag whole or leaves it out, never half a flag', () => {
    const flag = '\u{1F1FA}\u{1F1F8}';

    expect(tagNickname(`${'x'.repeat(22)}${flag}`)).toBe(`[AFK] ${'x'.repeat(22)}${flag}`);
    expect(tagNickname(`${'x'.repeat(24)}${flag}`)).toBe(`[AFK] ${'x'.repeat(24)}`);
  });

  test('never ends on a dangling joiner from an emoji sequence cut at the limit', () => {
    const family = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}';

    expect(tagNickname(`${'x'.repeat(22)}${family}`)).toBe(`[AFK] ${'x'.repeat(22)}`);
  });

  test('leaves a name that already carries the tag alone', () => {
    expect(isTagged('[AFK] Bob')).toBe(true);
    expect(tagNickname('[AFK] Bob')).toBe('[AFK] Bob');
  });
});

describe('displayName', () => {
  test('prefers the nickname, then the display name, then the username', () => {
    expect(displayName('Bobby', 'Bob', 'bob')).toBe('Bobby');
    expect(displayName(null, 'Bob', 'bob')).toBe('Bob');
    expect(displayName(undefined, null, 'bob')).toBe('bob');
    expect(displayName('', null, 'bob')).toBe('bob');
  });

  test('shows the name without the tag Proton added', () => {
    expect(untagged('[AFK] Bob')).toBe('Bob');
    expect(displayName('[AFK] Bob', null, 'bob')).toBe('Bob');
  });

  test('escapes markdown so a name cannot restyle or link the reply', () => {
    expect(displayName('**big** _x_ <@1> [a](b)', null, null)).toBe(
      '\\*\\*big\\*\\* \\_x\\_ \\<@1\\> \\[a\\](b)',
    );
  });

  test('breaks a URL in a name so Discord neither links nor previews it', () => {
    expect(displayName('https://grabify.link/x', null, null)).toBe('https\\://grabify.link/x');
    expect(renderWelcome(displayName('https://evil.pw/x', null, null), 0, 'none', 0)).toBe(
      'Welcome back, **https\\://evil.pw/x**. You were AFK for less than a minute.',
    );
  });
});

describe('renderNotice', () => {
  test('names the member, the reason and since when', () => {
    expect(renderNotice([{ name: 'Bob', reason: 'lunch', since: SINCE }])).toBe(
      `**Bob** is AFK: lunch · ${SINCE_TAG}`,
    );
  });

  test("an unclosed spoiler in one member's reason cannot swallow the next member's line", () => {
    const lines = renderNotice([
      { name: 'Alice', reason: 'back ||soon', since: SINCE },
      { name: 'Bob', reason: 'at || lunch', since: SINCE },
    ]).split('\n');

    expect(lines).toEqual([
      `**Alice** is AFK: back \\|\\|soon · ${SINCE_TAG}`,
      `**Bob** is AFK: at \\|\\| lunch · ${SINCE_TAG}`,
    ]);
  });

  test('leaves the reason out when there is none', () => {
    expect(renderNotice([{ name: 'Bob', reason: null, since: SINCE }])).toBe(
      `**Bob** is AFK · ${SINCE_TAG}`,
    );
  });

  test('lists five at most, then says how many more', () => {
    const entries = Array.from({ length: 7 }, (_, index) => ({
      name: `Member ${index}`,
      reason: null,
      since: SINCE,
    }));

    const lines = renderNotice(entries).split('\n');

    expect(lines).toHaveLength(6);
    expect(lines[4]).toContain('Member 4');
    expect(lines[5]).toBe('…and 2 more.');
  });
});

describe('renderWelcome', () => {
  test('with the recap sent', () => {
    expect(renderWelcome('Bob', 5 * 60_000, 'sent', 1)).toBe(
      "Welcome back, **Bob**. You were AFK for 5 minutes. I've sent you the 1 ping you missed.",
    );
    expect(renderWelcome('Bob', 5 * 60_000, 'sent', 3)).toContain('the 3 pings you missed');
  });

  test('with a recap that could not be delivered', () => {
    expect(renderWelcome('Bob', 60_000, 'undeliverable', 2)).toBe(
      'Welcome back, **Bob**. You were AFK for 1 minute. 2 pings came in while you were away, ' +
        "but I couldn't DM you the list.",
    );
  });

  test('with nothing to recap', () => {
    expect(renderWelcome('Bob', 10_000, 'none', 0)).toBe(
      'Welcome back, **Bob**. You were AFK for less than a minute.',
    );
  });

  test('at the recap limit, calls the list the latest pings rather than all of them', () => {
    expect(renderWelcome('Bob', 60_000, 'sent', RECAP_MAX)).toBe(
      "Welcome back, **Bob**. You were AFK for 1 minute. I've sent you the latest 25 pings you missed.",
    );
    expect(renderWelcome('Bob', 60_000, 'undeliverable', RECAP_MAX)).toBe(
      'Welcome back, **Bob**. You were AFK for 1 minute. At least 25 pings came in while you were ' +
        "away, but I couldn't DM you the list.",
    );
    expect(renderWelcome('Bob', 60_000, 'sent', RECAP_MAX - 1)).toContain(
      "I've sent you the 24 pings you missed.",
    );
  });

  test('names a nickname Proton could not take [AFK] off', () => {
    expect(
      renderWelcome(
        'Bob',
        60_000,
        'sent',
        2,
        "I'm missing the Manage Nicknames permission in this server.",
      ),
    ).toBe(
      "Welcome back, **Bob**. You were AFK for 1 minute. I've sent you the 2 pings you missed. I " +
        "couldn't take [AFK] off your nickname: I'm missing the Manage Nicknames permission in " +
        'this server.',
    );
  });
});

describe('formatElapsed', () => {
  test('reads like a person would say it', () => {
    expect(formatElapsed(30_000)).toBe('less than a minute');
    expect(formatElapsed(60_000)).toBe('1 minute');
    expect(formatElapsed(45 * 60_000)).toBe('45 minutes');
    expect(formatElapsed(3_600_000)).toBe('1 hour');
    expect(formatElapsed(2 * 3_600_000 + 5 * 60_000)).toBe('2 hours and 5 minutes');
    expect(formatElapsed(26 * 3_600_000)).toBe('1 day and 2 hours');
    expect(formatElapsed(3 * 86_400_000)).toBe('3 days');
  });
});

function ping(index: number): AfkPing {
  return {
    sessionId: '600000000000000001',
    guildId: GUILD,
    userId: '100000000000000001',
    messageId: `80000000000000000${String(index).padStart(2, '0')}`,
    channelId: '50000000000000000001',
    authorId: '10000000000000000002',
    pingedAt: new Date(SINCE.getTime() + index * 1000),
  };
}

describe('renderRecap', () => {
  test('one ping is one message, with a jump link', () => {
    const [only, ...rest] = renderRecap(GUILD, [ping(1)]);

    expect(rest).toEqual([]);
    expect(only?.split('\n')).toEqual([
      'You were pinged 1 time while you were AFK:',
      `<@10000000000000000002> in <#50000000000000000001> <t:${Math.floor(ping(1).pingedAt.getTime() / 1000)}:R> — ` +
        `https://discord.com/channels/${GUILD}/50000000000000000001/8000000000000000001`,
    ]);
  });

  test('twenty-five pings split across messages that each fit Discord’s limit, losing none', () => {
    const chunks = renderRecap(
      GUILD,
      Array.from({ length: 25 }, (_, index) => ping(index)),
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks[0]?.startsWith('Here are the 25 most recent pings from while you were AFK:'),
    ).toBe(true);

    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(MESSAGE_CONTENT_MAX);

    expect(chunks.join('\n').match(/https:\/\/discord\.com\/channels\//g)).toHaveLength(25);
  });

  test('below the limit, states the exact count', () => {
    const [first] = renderRecap(
      GUILD,
      Array.from({ length: RECAP_MAX - 1 }, (_, index) => ping(index)),
    );

    expect(first?.startsWith('You were pinged 24 times while you were AFK:')).toBe(true);
  });
});

describe('nicknameProblem', () => {
  test('explains each refusal Discord or Proton makes', () => {
    expect(nicknameProblem({ code: 'target_is_owner', humanReason: '' }, 'your')).toBe(
      "Discord doesn't let bots change the server owner's nickname.",
    );
    expect(nicknameProblem({ code: 'role_hierarchy', humanReason: '' }, 'your')).toBe(
      "your highest role is at or above mine. Move Proton's role higher in Server Settings → Roles.",
    );
    expect(nicknameProblem({ code: 'role_hierarchy', humanReason: '' }, 'their')).toContain(
      'their highest role',
    );
    expect(nicknameProblem({ code: 'missing_permission', humanReason: '' }, 'your')).toBe(
      "I'm missing the Manage Nicknames permission in this server.",
    );
    expect(nicknameProblem({ code: 'discord_500', humanReason: 'Discord broke.' }, 'your')).toBe(
      'Discord broke.',
    );
  });
});
