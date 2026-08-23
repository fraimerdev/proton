import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { ServerLogColors } from '../src/colours.ts';
import {
  channelMention,
  DESCRIPTION_MAX,
  escapeInline,
  FIELD_VALUE_MAX,
  INLINE_VALUE_MAX,
  isSnowflake,
  jumpUrl,
  type LogLine,
  logBody,
  logEmbed,
  logLine,
  roleMention,
  userMention,
} from '../src/embed.ts';
import { DEFAULT_EMOJIS, emojiSet, REPLY_FALLBACK, STEM_FALLBACK } from '../src/emoji.ts';

const EMOJIS = emojiSet({ stemId: '1539999327580192858', replyId: '1539999328674783242' });

describe('logLine', () => {
  test('renders label, mention and raw value in the owner’s shape', () => {
    expect(logLine(EMOJIS.stem, { label: 'Name', mention: '<#1>', value: '#general' })).toBe(
      '<:replycontinued:1539999327580192858> **Name:** <#1> `#general`',
    );
  });

  test('omits the mention when there is none', () => {
    expect(logLine(EMOJIS.reply, { label: 'Id', value: '42' })).toBe(
      '<:reply:1539999328674783242> **Id:** `42`',
    );
  });

  test('omits the code span when there is no value', () => {
    expect(logLine(EMOJIS.stem, { label: 'Roles', mention: '<@&1>' })).toBe(
      '<:replycontinued:1539999327580192858> **Roles:** <@&1>',
    );
  });
});

describe('logBody', () => {
  test('every line but the last uses stem, and the last uses reply', () => {
    const body = logBody([{ label: 'A' }, { label: 'B' }, { label: 'C' }], DEFAULT_EMOJIS).split(
      '\n',
    );

    expect(body[0]?.startsWith(STEM_FALLBACK)).toBe(true);
    expect(body[1]?.startsWith(STEM_FALLBACK)).toBe(true);
    expect(body[2]?.startsWith(REPLY_FALLBACK)).toBe(true);
  });

  test('a single line is a reply, not a stem', () => {
    expect(logBody([{ label: 'Only' }], DEFAULT_EMOJIS).startsWith(REPLY_FALLBACK)).toBe(true);
  });

  test('the stem/reply rule holds for any number of lines', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ label: fc.string({ minLength: 1, maxLength: 20 }) }), {
          minLength: 1,
          maxLength: 20,
        }),
        (lines: LogLine[]) => {
          const rendered = logBody(lines, DEFAULT_EMOJIS).split('\n');

          expect(rendered).toHaveLength(lines.length);
          for (const [index, line] of rendered.entries()) {
            const expected = index === rendered.length - 1 ? REPLY_FALLBACK : STEM_FALLBACK;
            expect(line.startsWith(expected)).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  test('a very long body is cut to what Discord accepts', () => {
    const lines = Array.from({ length: 400 }, () => ({
      label: 'x'.repeat(40),
      value: 'y'.repeat(40),
    }));

    expect(logBody(lines, DEFAULT_EMOJIS).length).toBeLessThanOrEqual(DESCRIPTION_MAX);
  });
});

describe('escapeInline', () => {
  test('a backtick cannot break out of the code span', () => {
    expect(escapeInline('we`ird')).not.toContain('`');
  });

  test('a channel named with backticks cannot corrupt the lines after it', () => {
    const body = logBody(
      [
        { label: 'Name', value: '`  **everything bold** ' },
        { label: 'Id', value: '1' },
      ],
      DEFAULT_EMOJIS,
    );

    expect(body.split('\n')).toHaveLength(2);
    expect(body.split('\n')[1]).toContain('**Id:**');
  });

  test('an absurd value is capped', () => {
    expect(escapeInline('z'.repeat(5000)).length).toBe(INLINE_VALUE_MAX);
  });
});

describe('logEmbed', () => {
  const base = {
    subject: 'Channel',
    action: 'created',
    colour: ServerLogColors.Add,
    lines: [{ label: 'Name', mention: '<#1>', value: '#general' }],
    occurredAt: Date.parse('2026-08-16T12:00:00.000Z'),
    emojis: EMOJIS,
  };

  test('the title carries no markdown, because Discord renders embed titles as plain text', () => {
    const embed = logEmbed({ ...base, executor: null });

    expect(embed.title).toBe('Channel created');
    expect(String(embed.title)).not.toContain('*');
  });

  test('an unknown executor still produces a footer', () => {
    const embed = logEmbed({ ...base, executor: null }) as { footer: { text: string } };

    expect(embed.footer.text).toBe('Unknown');
    expect(embed.footer).not.toHaveProperty('icon_url');
  });

  test('a known executor supplies the footer name and avatar', () => {
    const embed = logEmbed({
      ...base,
      executor: { id: '2', username: 'admin', avatarUrl: 'https://cdn/x.png' },
    }) as { footer: { text: string; icon_url: string } };

    expect(embed.footer.text).toBe('admin');
    expect(embed.footer.icon_url).toBe('https://cdn/x.png');
  });

  test('the colour and timestamp come straight through', () => {
    const embed = logEmbed({ ...base, executor: null });

    expect(embed.color).toBe(ServerLogColors.Add);
    expect(embed.timestamp).toBe('2026-08-16T12:00:00.000Z');
  });

  test('no fields key at all when there are no fields', () => {
    expect(logEmbed({ ...base, executor: null })).not.toHaveProperty('fields');
  });

  test('field values are cut to Discord’s limit', () => {
    const embed = logEmbed({
      ...base,
      executor: null,
      fields: [{ name: 'Before', value: 'q'.repeat(4000) }],
    }) as { fields: Array<{ value: string }> };

    expect(embed.fields[0]?.value.length).toBe(FIELD_VALUE_MAX);
  });
});

describe('emojiSet', () => {
  test('configured ids render as application emoji', () => {
    expect(emojiSet({ stemId: '1', replyId: '2' })).toEqual({
      stem: '<:replycontinued:1>',
      reply: '<:reply:2>',
    });
  });

  test('no ids fall back to characters that render everywhere', () => {
    expect(emojiSet()).toEqual({ stem: STEM_FALLBACK, reply: REPLY_FALLBACK });
  });

  test('one missing id only degrades that one', () => {
    expect(emojiSet({ stemId: '1' })).toEqual({
      stem: '<:replycontinued:1>',
      reply: REPLY_FALLBACK,
    });
  });
});

describe('jumpUrl', () => {
  test('points at the message', () => {
    expect(jumpUrl('9', '5', '1')).toBe('https://discord.com/channels/9/5/1');
  });
});

describe('mentions are only emitted for real snowflakes', () => {
  const SNOWFLAKE = '200000000000000009';

  test('a snowflake becomes a mention Discord can resolve', () => {
    expect(userMention(SNOWFLAKE)).toBe(`<@${SNOWFLAKE}>`);
    expect(channelMention(SNOWFLAKE)).toBe(`<#${SNOWFLAKE}>`);
    expect(roleMention(SNOWFLAKE)).toBe(`<@&${SNOWFLAKE}>`);
  });

  test('a Better Auth user id is not mentioned, because Discord renders it literally', () => {
    expect(userMention('I3T0JHbuEdAbLEgXmHcZeMyFF3ga2ANC')).toBeUndefined();
  });

  test('a module actor id is not mentioned', () => {
    expect(userMention('proton:antinuke')).toBeUndefined();
  });

  test('a missing id is not mentioned', () => {
    expect(userMention(undefined)).toBeUndefined();
    expect(channelMention('')).toBeUndefined();
  });

  test('isSnowflake accepts the id lengths Discord actually issues', () => {
    expect(isSnowflake('12345678901234567')).toBe(true);
    expect(isSnowflake('12345678901234567890')).toBe(true);
    expect(isSnowflake('1234567890123456')).toBe(false);
    expect(isSnowflake('123456789012345678901')).toBe(false);
    expect(isSnowflake('1234567890123456a')).toBe(false);
  });

  test('a line with no resolvable mention still renders its value', () => {
    const line = logLine(DEFAULT_EMOJIS.reply, {
      label: 'By',
      mention: userMention('not-a-snowflake'),
      value: 'not-a-snowflake',
    });

    expect(line).toBe('└ **By:** `not-a-snowflake`');
    expect(line).not.toContain('<@');
  });
});
