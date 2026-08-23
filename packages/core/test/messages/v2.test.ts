import { describe, expect, it } from 'bun:test';
import {
  COMPONENT_TYPE_CONTAINER,
  COMPONENT_TYPE_MEDIA_GALLERY,
  COMPONENT_TYPE_SECTION,
  COMPONENT_TYPE_SEPARATOR,
  COMPONENT_TYPE_TEXT_DISPLAY,
  COMPONENT_TYPE_THUMBNAIL,
  countV2Components,
  isComponentsV2,
  MESSAGE_FLAG_IS_COMPONENTS_V2,
  messageSchema,
  type ProtonMessage,
  sendPayloadSchema,
  toDiscordMessage,
  V2_COMPONENTS_MAX,
  type V2Component,
  v2ComponentsSchema,
} from '../../src/index.ts';

const customIdFor = (key: string) => `proton:embeds:promo:${key}`;

const roleAction = { kind: 'role', mode: 'toggle', roleId: '123456789012345678' } as const;

function parse(v2: unknown): ProtonMessage {
  return messageSchema.parse({ v2 });
}

function issues(value: unknown): string {
  const parsed = messageSchema.safeParse(value);
  return parsed.success
    ? ''
    : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' | ');
}

const TEXT = { kind: 'text', content: 'Hello' } as const;

describe('the v2 tree', () => {
  it('takes a bare text display', () => {
    expect(messageSchema.safeParse({ v2: [TEXT] }).success).toBe(true);
  });

  it('defaults a separator to a small divider', () => {
    const parsed = v2ComponentsSchema.parse([{ kind: 'separator' }]);
    expect(parsed[0]).toEqual({ kind: 'separator', divider: true, spacing: 'small' });
  });

  it('refuses a section with no accessory', () => {
    expect(issues({ v2: [{ kind: 'section', text: ['a'] }] })).toContain('accessory');
  });

  it('refuses a section holding more than three text displays', () => {
    const section = {
      kind: 'section',
      text: ['a', 'b', 'c', 'd'],
      accessory: { kind: 'thumbnail', url: 'https://example.com/t.png' },
    };

    expect(messageSchema.safeParse({ v2: [section] }).success).toBe(false);
  });

  it('refuses a media gallery with no items', () => {
    expect(messageSchema.safeParse({ v2: [{ kind: 'gallery', items: [] }] }).success).toBe(false);
  });

  it('refuses a media gallery past ten items', () => {
    const items = Array.from({ length: 11 }, () => ({ url: 'https://example.com/a.png' }));
    expect(messageSchema.safeParse({ v2: [{ kind: 'gallery', items }] }).success).toBe(false);
  });

  it('refuses a container nested in a container', () => {
    const inner = { kind: 'container', children: [TEXT] };
    const outer = { kind: 'container', children: [inner] };

    expect(messageSchema.safeParse({ v2: [outer] }).success).toBe(false);
  });

  it('refuses an empty container', () => {
    expect(messageSchema.safeParse({ v2: [{ kind: 'container', children: [] }] }).success).toBe(
      false,
    );
  });

  it('refuses a media url that is not http', () => {
    const gallery = { kind: 'gallery', items: [{ url: 'javascript:alert(1)' }] };
    expect(messageSchema.safeParse({ v2: [gallery] }).success).toBe(false);
  });
});

describe('the components-v2 exclusivity rule', () => {
  it('refuses a layout that also carries text', () => {
    expect(issues({ content: 'hi', v2: [TEXT] })).toContain('whole message');
  });

  it('refuses a layout that also carries an embed', () => {
    expect(issues({ embeds: [{ title: 'x' }], v2: [TEXT] })).toContain('whole message');
  });

  it('refuses a layout that also carries a plain button row', () => {
    const components = [
      {
        kind: 'buttons',
        buttons: [{ key: 'a', style: 'primary', label: 'A', action: roleAction }],
      },
    ];

    expect(issues({ components, v2: [TEXT] })).toContain('whole message');
  });

  it('takes a layout that is the whole message', () => {
    expect(messageSchema.safeParse({ v2: [TEXT] }).success).toBe(true);
  });
});

describe('the 40-component budget', () => {
  it('counts a section as itself plus its text displays plus its accessory', () => {
    const section: V2Component = {
      kind: 'section',
      text: ['a', 'b'],
      accessory: { kind: 'thumbnail', url: 'https://example.com/t.png' },
    };

    expect(countV2Components([section])).toBe(4);
  });

  it('counts a button row as itself plus each button', () => {
    const row: V2Component = {
      kind: 'row',
      row: {
        kind: 'buttons',
        buttons: [
          { key: 'a', style: 'link', label: 'A', url: 'https://a.example' },
          { key: 'b', style: 'link', label: 'B', url: 'https://b.example' },
        ],
      },
    };

    expect(countV2Components([row])).toBe(3);
  });

  // A top-level array cap would pass here while the tree underneath was unbounded.
  it('counts the whole tree, not just the top level', () => {
    const container: V2Component = {
      kind: 'container',
      children: Array.from({ length: 5 }, () => ({ kind: 'text', content: 'x' }) as const),
    };

    expect(countV2Components([container])).toBe(6);
  });

  it('refuses a layout past the budget and says how many to remove', () => {
    const children = Array.from(
      { length: V2_COMPONENTS_MAX + 1 },
      () => ({ kind: 'text', content: 'x' }) as const,
    );

    expect(issues({ v2: [{ kind: 'container', children }] })).toContain(
      `Discord allows ${V2_COMPONENTS_MAX}`,
    );
  });
});

describe('component keys across the tree', () => {
  function button(key: string) {
    return { key, style: 'primary', label: key, action: roleAction };
  }

  it('refuses two rows in different containers sharing a key', () => {
    const v2 = [
      {
        kind: 'container',
        children: [{ kind: 'row', row: { kind: 'buttons', buttons: [button('same')] } }],
      },
      { kind: 'row', row: { kind: 'buttons', buttons: [button('same')] } },
    ];

    expect(issues({ v2 })).toContain('could not tell which one was pressed');
  });

  it('refuses a section accessory button sharing a key with a row button', () => {
    const v2 = [
      { kind: 'section', text: ['a'], accessory: { kind: 'button', button: button('same') } },
      { kind: 'row', row: { kind: 'buttons', buttons: [button('same')] } },
    ];

    expect(issues({ v2 })).toContain('could not tell which one was pressed');
  });

  it('allows distinct keys nested at different depths', () => {
    const v2 = [
      {
        kind: 'container',
        children: [{ kind: 'row', row: { kind: 'buttons', buttons: [button('one')] } }],
      },
      { kind: 'row', row: { kind: 'buttons', buttons: [button('two')] } },
    ];

    expect(messageSchema.safeParse({ v2 }).success).toBe(true);
  });
});

describe('toDiscordMessage under components v2', () => {
  it('sets the IS_COMPONENTS_V2 flag', () => {
    const body = toDiscordMessage(parse([TEXT]), { customIdFor });
    expect(body.flags).toBe(MESSAGE_FLAG_IS_COMPONENTS_V2);
  });

  it('sends no content and no embeds, which Discord would refuse', () => {
    const body = toDiscordMessage(parse([TEXT]), { customIdFor });

    expect(body.content).toBeUndefined();
    expect(body.embeds).toBeUndefined();
  });

  it('leaves a classic message unflagged', () => {
    const body = toDiscordMessage(messageSchema.parse({ content: 'hi' }), { customIdFor });
    expect(body.flags).toBeUndefined();
  });

  it('emits a text display as type 10', () => {
    const body = toDiscordMessage(parse([TEXT]), { customIdFor });
    expect(body.components?.[0]).toEqual({ type: COMPONENT_TYPE_TEXT_DISPLAY, content: 'Hello' });
  });

  it('emits a separator with its numeric spacing', () => {
    const body = toDiscordMessage(parse([{ kind: 'separator', spacing: 'large' }]), {
      customIdFor,
    });

    expect(body.components?.[0]).toEqual({
      type: COMPONENT_TYPE_SEPARATOR,
      divider: true,
      spacing: 2,
    });
  });

  it('nests a media gallery item under `media`', () => {
    const gallery = {
      kind: 'gallery',
      items: [{ url: 'https://example.com/a.png', description: 'alt', spoiler: true }],
    };

    const body = toDiscordMessage(parse([gallery]), { customIdFor });

    expect(body.components?.[0]?.type).toBe(COMPONENT_TYPE_MEDIA_GALLERY);
    expect(body.components?.[0]?.items?.[0]).toEqual({
      media: { url: 'https://example.com/a.png' },
      description: 'alt',
      spoiler: true,
    });
  });

  it('emits a section with its text displays and a thumbnail accessory', () => {
    const section = {
      kind: 'section',
      text: ['one', 'two'],
      accessory: { kind: 'thumbnail', url: 'https://example.com/t.png' },
    };

    const emitted = toDiscordMessage(parse([section]), { customIdFor }).components?.[0];

    expect(emitted?.type).toBe(COMPONENT_TYPE_SECTION);
    expect(emitted?.components).toHaveLength(2);
    expect(emitted?.components?.[0]).toEqual({
      type: COMPONENT_TYPE_TEXT_DISPLAY,
      content: 'one',
    });
    expect(emitted?.accessory).toEqual({
      type: COMPONENT_TYPE_THUMBNAIL,
      media: { url: 'https://example.com/t.png' },
    });
  });

  it('emits a section whose accessory is a button, with its custom_id', () => {
    const section = {
      kind: 'section',
      text: ['one'],
      accessory: {
        kind: 'button',
        button: { key: 'go', style: 'primary', label: 'Go', action: roleAction },
      },
    };

    const accessory = toDiscordMessage(parse([section]), { customIdFor }).components?.[0]
      ?.accessory;

    expect(accessory?.type).toBe(2);
    expect(accessory?.custom_id).toBe('proton:embeds:promo:go');
  });

  it('emits a container with its accent colour and children', () => {
    const container = {
      kind: 'container',
      accentColor: 0x5865f2,
      spoiler: true,
      children: [TEXT, { kind: 'separator' }],
    };

    const emitted = toDiscordMessage(parse([container]), { customIdFor }).components?.[0];

    expect(emitted?.type).toBe(COMPONENT_TYPE_CONTAINER);
    expect(emitted?.accent_color).toBe(0x5865f2);
    expect(emitted?.spoiler).toBe(true);
    expect(emitted?.components).toHaveLength(2);
  });

  it('omits an absent accent colour rather than sending null', () => {
    const container = { kind: 'container', children: [TEXT] };
    const emitted = toDiscordMessage(parse([container]), { customIdFor }).components?.[0];

    expect(emitted).not.toHaveProperty('accent_color');
  });

  it('still carries allowed mentions', () => {
    const body = toDiscordMessage(parse([TEXT]), { customIdFor });
    expect(body.allowedMentions).toEqual({ parse: ['roles', 'users'] });
  });
});

describe('the executor boundary agrees with the builder', () => {
  it('accepts the body a v2 message produces', () => {
    const body = toDiscordMessage(parse([TEXT]), { customIdFor });

    const payload = sendPayloadSchema.safeParse({
      channelId: '900000000000000001',
      ...body,
    });

    expect(payload.success).toBe(true);
  });

  // The exclusivity refine lives at the executor too, so a caller that hand-builds a flagged
  // payload with content is refused before it becomes an opaque 400 from the proxy.
  it('refuses a flagged payload that still carries content', () => {
    const payload = sendPayloadSchema.safeParse({
      channelId: '900000000000000001',
      content: 'hi',
      components: [{ type: COMPONENT_TYPE_TEXT_DISPLAY, content: 'x' }],
      flags: MESSAGE_FLAG_IS_COMPONENTS_V2,
    });

    expect(payload.success).toBe(false);
  });
});

describe('isComponentsV2', () => {
  it('is true only when the layout has something in it', () => {
    expect(isComponentsV2(parse([TEXT]))).toBe(true);
    expect(isComponentsV2(messageSchema.parse({ content: 'hi' }))).toBe(false);
  });
});
