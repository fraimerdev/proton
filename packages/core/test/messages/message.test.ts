import { describe, expect, it } from 'bun:test';
import {
  type ActionRow,
  DEFAULT_MENTION_POLICY,
  EMBED_TOTAL_MAX,
  type Embed,
  embedLength,
  embedsLength,
  findComponentAction,
  formatComponentEmoji,
  isEmptyEmbed,
  liftLegacyMessage,
  messageSchema,
  parseComponentEmoji,
  storedMessageSchema,
  toAllowedMentions,
  toDiscordEmbed,
  toDiscordMessage,
} from '../../src/index.ts';

const customIdFor = (key: string) => `proton:embeds:welcome:${key}`;

function issues(value: unknown): string[] {
  const parsed = messageSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('messageSchema', () => {
  it('takes content alone', () => {
    expect(messageSchema.safeParse({ content: 'hello' }).success).toBe(true);
  });

  it('takes an embed alone', () => {
    expect(messageSchema.safeParse({ embeds: [{ title: 'Rules' }] }).success).toBe(true);
  });

  it('refuses a message holding nothing', () => {
    expect(issues({}).join()).toContain('nothing in it');
  });

  it('refuses whitespace-only content as the message’s only substance', () => {
    expect(issues({ content: '   ' }).join()).toContain('nothing in it');
  });

  it('refuses an embed holding nothing', () => {
    expect(issues({ embeds: [{ color: 0x5865f2 }] }).join()).toContain('this embed has nothing');
  });

  it('refuses more than ten embeds', () => {
    const embeds = Array.from({ length: 11 }, (_, i) => ({ title: `e${i}` }));
    expect(messageSchema.safeParse({ embeds }).success).toBe(false);
  });

  it('counts the 6000 budget across every embed, not per embed', () => {
    const embeds = Array.from({ length: 3 }, () => ({ description: 'x'.repeat(2100) }));

    expect(embedsLength(embeds as Embed[])).toBe(6300);
    expect(issues({ embeds }).join()).toContain(`Discord allows ${EMBED_TOTAL_MAX}`);
  });

  it('lets three embeds under the shared budget through', () => {
    const embeds = Array.from({ length: 3 }, () => ({ description: 'x'.repeat(1900) }));
    expect(messageSchema.safeParse({ embeds }).success).toBe(true);
  });

  it('names the repeated link when two embeds share a url', () => {
    const embeds = [
      { title: 'a', url: 'https://example.com/x' },
      { title: 'b', url: 'https://example.com/x' },
    ];

    expect(issues({ embeds }).join()).toContain('would never appear');
  });

  it('allows two embeds with different urls', () => {
    const embeds = [
      { title: 'a', url: 'https://example.com/x' },
      { title: 'b', url: 'https://example.com/y' },
    ];

    expect(messageSchema.safeParse({ embeds }).success).toBe(true);
  });

  it('defaults the mention policy to everything but @everyone', () => {
    const parsed = messageSchema.parse({ content: 'hi' });
    expect(parsed.mentions).toEqual(DEFAULT_MENTION_POLICY);
  });
});

describe('embed limits', () => {
  it('trims before counting, the way Discord does', () => {
    expect(embedLength({ title: '  ab  ', embeds: [] } as unknown as Embed)).toBe(2);
  });

  it('counts field names and values but not urls', () => {
    const embed: Embed = {
      title: 'abc',
      url: 'https://example.com/a-very-long-address-that-is-not-counted',
      fields: [{ name: 'ab', value: 'cde' }],
    };

    expect(embedLength(embed)).toBe(8);
  });

  it('treats an embed carrying only an image as non-empty', () => {
    expect(isEmptyEmbed({ imageUrl: 'https://example.com/a.png' })).toBe(false);
  });

  it('refuses a description past 4096', () => {
    expect(messageSchema.safeParse({ embeds: [{ description: 'x'.repeat(4097) }] }).success).toBe(
      false,
    );
  });

  it('refuses more than 25 fields', () => {
    const fields = Array.from({ length: 26 }, (_, i) => ({ name: `n${i}`, value: 'v' }));
    expect(messageSchema.safeParse({ embeds: [{ fields }] }).success).toBe(false);
  });
});

describe('toDiscordEmbed', () => {
  it('omits absent keys rather than sending null', () => {
    expect(toDiscordEmbed({ title: 'Rules' })).toEqual({ title: 'Rules' });
  });

  it('nests footer and author the way Discord wants them', () => {
    const body = toDiscordEmbed({
      footer: { text: 'Proton', iconUrl: 'https://example.com/i.png' },
      author: { name: 'Staff', url: 'https://example.com', iconUrl: 'https://example.com/a.png' },
    });

    expect(body.footer).toEqual({ text: 'Proton', icon_url: 'https://example.com/i.png' });
    expect(body.author).toEqual({
      name: 'Staff',
      url: 'https://example.com',
      icon_url: 'https://example.com/a.png',
    });
  });

  it('resolves a "now" timestamp against the clock it is given', () => {
    const now = new Date('2026-08-21T10:00:00.000Z');
    expect(toDiscordEmbed({ title: 'a', timestamp: 'now' }, now).timestamp).toBe(
      '2026-08-21T10:00:00.000Z',
    );
  });

  it('passes a fixed timestamp through untouched', () => {
    const at = '2020-01-02T03:04:05.000Z';
    expect(toDiscordEmbed({ title: 'a', timestamp: at }).timestamp).toBe(at);
  });

  it('maps imageUrl and thumbnailUrl into Discord’s nested objects', () => {
    const body = toDiscordEmbed({
      imageUrl: 'https://example.com/i.png',
      thumbnailUrl: 'https://example.com/t.png',
    });

    expect(body.image).toEqual({ url: 'https://example.com/i.png' });
    expect(body.thumbnail).toEqual({ url: 'https://example.com/t.png' });
  });
});

describe('liftLegacyMessage', () => {
  const legacy = {
    name: 'rules',
    title: 'Server rules',
    description: 'Be nice',
    color: 0x5865f2,
    footer: 'Proton',
    authorName: 'Staff',
    timestamp: true,
    fields: [{ name: 'One', value: 'Be nice' }],
  };

  it('keeps a legacy flat embed instead of stripping it to nothing', () => {
    const lifted = liftLegacyMessage(legacy) as { name: string; embeds: Embed[] };

    expect(lifted.name).toBe('rules');
    expect(lifted.embeds).toHaveLength(1);
    expect(lifted.embeds[0]?.title).toBe('Server rules');
    expect(lifted.embeds[0]?.description).toBe('Be nice');
    expect(lifted.embeds[0]?.color).toBe(0x5865f2);
  });

  it('lifts the flat footer and author strings into their objects', () => {
    const lifted = liftLegacyMessage(legacy) as { embeds: Embed[] };

    expect(lifted.embeds[0]?.footer).toEqual({ text: 'Proton' });
    expect(lifted.embeds[0]?.author).toEqual({ name: 'Staff' });
  });

  it('turns the legacy boolean timestamp into "now"', () => {
    expect((liftLegacyMessage(legacy) as { embeds: Embed[] }).embeds[0]?.timestamp).toBe('now');
  });

  it('drops a false legacy timestamp rather than stamping the message', () => {
    const lifted = liftLegacyMessage({ title: 'a', timestamp: false }) as { embeds: Embed[] };
    expect(lifted.embeds[0]?.timestamp).toBeUndefined();
  });

  it('leaves an already-migrated message alone', () => {
    const modern = { name: 'rules', content: 'hi', embeds: [{ title: 'x' }] };
    expect(liftLegacyMessage(modern)).toBe(modern);
  });

  it('leaves a message that only has components alone', () => {
    const modern = { name: 'rules', components: [] };
    expect(liftLegacyMessage(modern)).toBe(modern);
  });

  it('parses a stored legacy row without losing a single field', () => {
    const parsed = storedMessageSchema.safeParse(legacy);

    expect(parsed.success).toBe(true);
    const message = parsed.data as { embeds: Embed[] };
    expect(message.embeds[0]?.fields).toEqual([{ name: 'One', value: 'Be nice' }]);
  });

  it('is a no-op on values that are not objects', () => {
    expect(liftLegacyMessage(null)).toBeNull();
    expect(liftLegacyMessage('x')).toBe('x');
    expect(liftLegacyMessage([1])).toEqual([1]);
  });

  it('does not resurrect a prototype key', () => {
    const lifted = liftLegacyMessage({ title: 'a' }) as Record<string, unknown>;
    expect(Object.hasOwn(lifted, 'constructor')).toBe(false);
  });
});

describe('toAllowedMentions', () => {
  it('always carries an explicit parse array', () => {
    expect(toAllowedMentions()).toEqual({ parse: ['roles', 'users'] });
  });

  it('suppresses everything when every switch is off', () => {
    expect(toAllowedMentions({ everyone: false, roles: false, users: false })).toEqual({
      parse: [],
    });
  });

  it('lets @everyone through only when asked', () => {
    expect(toAllowedMentions({ everyone: true, roles: true, users: true }).parse).toEqual([
      'roles',
      'users',
      'everyone',
    ]);
  });
});

describe('components', () => {
  const roleAction = { kind: 'role', mode: 'toggle', roleId: '123456789012345678' } as const;

  function componentIssues(components: unknown): string {
    const parsed = messageSchema.safeParse({ content: 'x', components });
    return parsed.success
      ? ''
      : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' | ');
  }

  it('takes a link button with a url and no action', () => {
    const components = [
      {
        kind: 'buttons',
        buttons: [{ key: 'docs', style: 'link', label: 'Docs', url: 'https://example.com' }],
      },
    ];

    expect(messageSchema.safeParse({ content: 'x', components }).success).toBe(true);
  });

  it('refuses a link button carrying an action', () => {
    const components = [
      {
        kind: 'buttons',
        buttons: [
          {
            key: 'docs',
            style: 'link',
            label: 'Docs',
            url: 'https://example.com',
            action: roleAction,
          },
        ],
      },
    ];

    expect(componentIssues(components)).toContain('never reaches Proton');
  });

  it('refuses a non-link button with no action', () => {
    const components = [
      { kind: 'buttons', buttons: [{ key: 'a', style: 'primary', label: 'Press' }] },
    ];

    expect(componentIssues(components)).toContain('would do nothing when pressed');
  });

  it('refuses a button with neither label nor emoji', () => {
    const components = [
      { kind: 'buttons', buttons: [{ key: 'a', style: 'primary', action: roleAction }] },
    ];

    expect(componentIssues(components)).toContain('needs a label, an emoji, or both');
  });

  it('takes an emoji-only button', () => {
    const components = [
      {
        kind: 'buttons',
        buttons: [{ key: 'a', style: 'primary', emoji: { name: '👍' }, action: roleAction }],
      },
    ];

    expect(messageSchema.safeParse({ content: 'x', components }).success).toBe(true);
  });

  it('refuses more than five buttons in one row', () => {
    const buttons = Array.from({ length: 6 }, (_, i) => ({
      key: `b${i}`,
      style: 'primary',
      label: 'x',
      action: roleAction,
    }));

    expect(
      messageSchema.safeParse({ content: 'x', components: [{ kind: 'buttons', buttons }] }).success,
    ).toBe(false);
  });

  it('refuses more than five rows', () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      kind: 'buttons',
      buttons: [{ key: `b${i}`, style: 'primary', label: 'x', action: roleAction }],
    }));

    expect(messageSchema.safeParse({ content: 'x', components: rows }).success).toBe(false);
  });

  it('refuses two components sharing a key', () => {
    const rows = [
      {
        kind: 'buttons',
        buttons: [{ key: 'same', style: 'primary', label: 'a', action: roleAction }],
      },
      {
        kind: 'buttons',
        buttons: [{ key: 'same', style: 'primary', label: 'b', action: roleAction }],
      },
    ];

    expect(componentIssues(rows)).toContain('could not tell which one was pressed');
  });

  it('lets two link buttons share a key, since neither reports back', () => {
    const rows = [
      {
        kind: 'buttons',
        buttons: [
          { key: 'x', style: 'link', label: 'a', url: 'https://a.example' },
          { key: 'x', style: 'link', label: 'b', url: 'https://b.example' },
        ],
      },
    ];

    expect(messageSchema.safeParse({ content: 'x', components: rows }).success).toBe(true);
  });

  it('refuses a select that lets someone pick more options than it holds', () => {
    const rows = [
      {
        kind: 'select',
        select: {
          key: 'pick',
          maxValues: 5,
          options: [{ key: 'a', label: 'A', action: roleAction }],
        },
      },
    ];

    expect(componentIssues(rows)).toContain('Discord refuses that');
  });

  it('refuses duplicate option keys in one select', () => {
    const rows = [
      {
        kind: 'select',
        select: {
          key: 'pick',
          options: [
            { key: 'a', label: 'A', action: roleAction },
            { key: 'a', label: 'B', action: roleAction },
          ],
        },
      },
    ];

    expect(componentIssues(rows)).toContain('could not say which');
  });
});

describe('toDiscordMessage', () => {
  it('encodes a custom_id for an action button but a url for a link button', () => {
    const message = messageSchema.parse({
      content: 'Pick one',
      components: [
        {
          kind: 'buttons',
          buttons: [
            {
              key: 'blue',
              style: 'primary',
              label: 'Blue',
              action: { kind: 'role', mode: 'toggle', roleId: '123456789012345678' },
            },
            { key: 'docs', style: 'link', label: 'Docs', url: 'https://example.com' },
          ],
        },
      ],
    });

    const body = toDiscordMessage(message, { customIdFor });
    const row = body.components?.[0];

    expect(row?.type).toBe(1);
    expect(row?.components?.[0]?.custom_id).toBe('proton:embeds:welcome:blue');
    expect(row?.components?.[0]?.style).toBe(1);
    expect(row?.components?.[0]?.url).toBeUndefined();
    expect(row?.components?.[1]?.url).toBe('https://example.com');
    expect(row?.components?.[1]?.custom_id).toBeUndefined();

    expect(row?.components?.[1]?.style).toBe(5);
  });

  it('sends the option key as the select value', () => {
    const message = messageSchema.parse({
      content: 'x',
      components: [
        {
          kind: 'select',
          select: {
            key: 'pick',
            placeholder: 'Choose',
            options: [
              {
                key: 'red',
                label: 'Red',
                action: { kind: 'role', mode: 'add', roleId: '123456789012345678' },
              },
            ],
          },
        },
      ],
    });

    const select = toDiscordMessage(message, { customIdFor }).components?.[0]?.components?.[0];

    expect(select?.type).toBe(3);
    expect(select?.custom_id).toBe('proton:embeds:welcome:pick');
    expect(select?.options?.[0]).toEqual({ label: 'Red', value: 'red' });
  });

  it('omits content, embeds and components that are not there', () => {
    const body = toDiscordMessage(messageSchema.parse({ content: 'hi' }), { customIdFor });

    expect(body.content).toBe('hi');
    expect(body.embeds).toBeUndefined();
    expect(body.components).toBeUndefined();
  });

  it('always carries allowed mentions', () => {
    const body = toDiscordMessage(messageSchema.parse({ content: 'hi' }), { customIdFor });
    expect(body.allowedMentions).toEqual({ parse: ['roles', 'users'] });
  });

  it('trims content the way the length check assumed', () => {
    const body = toDiscordMessage(messageSchema.parse({ content: '  hi  ' }), { customIdFor });
    expect(body.content).toBe('hi');
  });
});

describe('findComponentAction', () => {
  const rows: ActionRow[] = [
    {
      kind: 'buttons',
      buttons: [
        {
          key: 'blue',
          style: 'primary',
          label: 'Blue',
          action: { kind: 'role', mode: 'toggle', roleId: '123456789012345678' },
        },
      ],
    },
    {
      kind: 'select',
      select: {
        key: 'pick',
        options: [
          {
            key: 'red',
            label: 'Red',
            action: { kind: 'reply', content: 'You picked red', ephemeral: true },
          },
        ],
      },
    },
  ];

  it('finds a button’s action by key', () => {
    expect(findComponentAction(rows, 'blue')).toEqual({
      kind: 'role',
      mode: 'toggle',
      roleId: '123456789012345678',
    });
  });

  it('finds a select option’s action by both keys', () => {
    expect(findComponentAction(rows, 'pick', 'red')).toEqual({
      kind: 'reply',
      content: 'You picked red',
      ephemeral: true,
    });
  });

  it('returns nothing for an unknown key', () => {
    expect(findComponentAction(rows, 'nope')).toBeUndefined();
    expect(findComponentAction(rows, 'pick', 'nope')).toBeUndefined();
  });
});

describe('parseComponentEmoji', () => {
  it('reads a custom emoji', () => {
    expect(parseComponentEmoji('<:proton:123456789012345678>')).toEqual({
      name: 'proton',
      id: '123456789012345678',
    });
  });

  it('reads an animated custom emoji', () => {
    expect(parseComponentEmoji('<a:spin:123456789012345678>')).toEqual({
      name: 'spin',
      id: '123456789012345678',
      animated: true,
    });
  });

  it('reads the bare name:id form people paste', () => {
    expect(parseComponentEmoji('proton:123456789012345678')).toEqual({
      name: 'proton',
      id: '123456789012345678',
    });
  });

  it('treats anything else as a unicode emoji', () => {
    expect(parseComponentEmoji('👍')).toEqual({ name: '👍' });
  });

  it('reads nothing from blank input', () => {
    expect(parseComponentEmoji('   ')).toBeUndefined();
    expect(parseComponentEmoji(undefined)).toBeUndefined();
  });

  it('round-trips through formatComponentEmoji', () => {
    for (const raw of ['<:proton:123456789012345678>', '<a:spin:123456789012345678>', '👍']) {
      expect(formatComponentEmoji(parseComponentEmoji(raw))).toBe(raw);
    }
  });
});
