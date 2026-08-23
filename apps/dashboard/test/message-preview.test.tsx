import { describe, expect, test } from 'bun:test';
import { messageSchema, type ProtonMessage } from '@proton/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessagePreview } from '../src/components/message/preview.tsx';

const CHANNELS = [{ id: '900000000000000001', name: 'announcements', type: 0 }];
const ROLES = [{ id: '800000000000000001', name: 'Verified', position: 3, color: 0x4fcf95 }];

const NOW = new Date('2026-08-21T16:21:00.000Z');

function render(value: unknown): string {
  const message = messageSchema.parse(value) as ProtonMessage;

  return renderToStaticMarkup(
    <MessagePreview channels={CHANNELS} message={message} now={NOW} roles={ROLES} />,
  );
}

function countOf(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe('the Discord preview', () => {
  test('names the bot and marks it as one', () => {
    const html = render({ content: 'hello' });

    expect(html).toContain('dc-bot');
    expect(html).toContain('BOT');
    expect(html).toContain('Proton');
  });

  test('says what is missing when there is nothing to show', () => {
    const html = renderToStaticMarkup(
      <MessagePreview
        channels={CHANNELS}
        message={{
          content: undefined,
          embeds: [],
          components: [],
          mentions: { everyone: false, roles: true, users: true },
          v2: [],
        }}
        now={NOW}
        roles={ROLES}
      />,
    );

    expect(html).toContain('Discord refuses a message');
  });
});

describe('markdown, per field', () => {
  test('renders markdown in an embed description', () => {
    const html = render({ embeds: [{ description: '**bold** and *italic*' }] });

    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
  });

  test('renders markdown in a field value', () => {
    const html = render({ embeds: [{ fields: [{ name: 'n', value: '**bold**' }] }] });
    expect(html).toContain('<strong>bold</strong>');
  });

  // Discord shows these three as literal characters. A preview that bolded them would promise
  // formatting the posted embed will not have.
  test('leaves an embed title, author name and footer as literal text', () => {
    const html = render({
      embeds: [
        {
          title: '**not bold**',
          author: { name: '**not bold**' },
          footer: { text: '**not bold**' },
        },
      ],
    });

    expect(html).toContain('**not bold**');
    expect(countOf(html, '<strong>')).toBe(0);
  });

  test('resolves a channel mention to its name', () => {
    expect(render({ content: 'go to <#900000000000000001>' })).toContain('#announcements');
  });

  test('resolves a role mention to its name', () => {
    expect(render({ content: 'ask a <@&800000000000000001>' })).toContain('@Verified');
  });

  test('shows an unknown role by id rather than inventing a name', () => {
    expect(render({ content: '<@&800000000000000009>' })).toContain('800000000000000009');
  });

  test('never emits an anchor, so the preview cannot navigate away', () => {
    const html = render({ content: 'a [masked link](https://example.com) here' });

    expect(html).toContain('masked link');
    expect(countOf(html, '<a ')).toBe(0);
  });

  test('does not parse markdown inside code', () => {
    const html = render({ embeds: [{ description: '`**literal**`' }] });

    expect(html).toContain('**literal**');
    expect(countOf(html, '<strong>')).toBe(0);
  });
});

describe('embed layout', () => {
  test('takes the accent bar from the embed colour', () => {
    expect(render({ embeds: [{ title: 'x', color: 0x5865f2 }] })).toContain('#5865f2');
  });

  test('falls back to a neutral accent when no colour is set', () => {
    expect(render({ embeds: [{ title: 'x' }] })).toContain('#4f545c');
  });

  test('packs three inline fields into one row and breaks on a non-inline one', () => {
    const html = render({
      embeds: [
        {
          fields: [
            { name: 'a', value: '1', inline: true },
            { name: 'b', value: '2', inline: true },
            { name: 'c', value: '3', inline: true },
            { name: 'd', value: '4', inline: false },
          ],
        },
      ],
    });

    expect(countOf(html, 'dc-field-row')).toBe(2);
    expect(countOf(html, 'dc-field"')).toBe(4);
  });

  test('starts a fresh row after three inline fields', () => {
    const html = render({
      embeds: [
        {
          fields: Array.from({ length: 4 }, (_, i) => ({
            name: `n${i}`,
            value: 'v',
            inline: true,
          })),
        },
      ],
    });

    expect(countOf(html, 'dc-field-row')).toBe(2);
  });

  test('renders every embed on the message', () => {
    const html = render({ embeds: [{ title: 'one' }, { title: 'two' }, { title: 'three' }] });
    expect(countOf(html, 'dc-embed"')).toBe(3);
  });

  test('resolves a "now" timestamp against the clock it is given', () => {
    expect(render({ embeds: [{ title: 'x', timestamp: 'now' }] })).toContain('Today at');
  });

  test('shows a fixed timestamp as a date rather than as today', () => {
    const html = render({ embeds: [{ title: 'x', timestamp: '2020-01-02T03:04:05.000Z' }] });
    const footer = html.slice(html.indexOf('dc-embed-footer'));

    expect(footer).toContain('2020');
    expect(footer).not.toContain('Today at');
  });

  test('carries author and footer icons through as images', () => {
    const html = render({
      embeds: [
        {
          author: { name: 'Staff', iconUrl: 'https://example.com/a.png' },
          footer: { text: 'Proton', iconUrl: 'https://example.com/f.png' },
        },
      ],
    });

    expect(html).toContain('dc-embed-author-icon');
    expect(html).toContain('dc-embed-footer-icon');
  });

  test('does not leak a referrer when it loads an authored image', () => {
    const html = render({ embeds: [{ imageUrl: 'https://example.com/i.png' }] });
    expect(html.toLowerCase()).toContain('referrerpolicy="no-referrer"');
  });
});

describe('components', () => {
  const roleAction = { kind: 'role', mode: 'toggle', roleId: '800000000000000001' } as const;

  test('renders each button style with its own Discord colour class', () => {
    const html = render({
      content: 'x',
      components: [
        {
          kind: 'buttons',
          buttons: [
            { key: 'a', style: 'primary', label: 'A', action: roleAction },
            { key: 'b', style: 'success', label: 'B', action: roleAction },
            { key: 'c', style: 'danger', label: 'C', action: roleAction },
            { key: 'd', style: 'link', label: 'D', url: 'https://example.com' },
          ],
        },
      ],
    });

    expect(html).toContain('dc-button-primary');
    expect(html).toContain('dc-button-success');
    expect(html).toContain('dc-button-danger');
    expect(html).toContain('dc-button-link');
  });

  test('marks a link button as leaving Discord', () => {
    const html = render({
      content: 'x',
      components: [
        {
          kind: 'buttons',
          buttons: [{ key: 'd', style: 'link', label: 'D', url: 'https://example.com' }],
        },
      ],
    });

    expect(html).toContain('dc-button-external');
  });

  test('says what an action button will do', () => {
    const html = render({
      content: 'x',
      components: [
        {
          kind: 'buttons',
          buttons: [{ key: 'a', style: 'primary', label: 'A', action: roleAction }],
        },
      ],
    });

    expect(html).toContain('toggle the Verified role');
  });

  test('shows a dropdown placeholder until an option is the default', () => {
    const html = render({
      content: 'x',
      components: [
        {
          kind: 'select',
          select: {
            key: 'pick',
            placeholder: 'Choose one',
            options: [{ key: 'a', label: 'A', action: roleAction }],
          },
        },
      ],
    });

    expect(html).toContain('Choose one');
  });

  test('shows the default option instead of the placeholder when one is set', () => {
    const html = render({
      content: 'x',
      components: [
        {
          kind: 'select',
          select: {
            key: 'pick',
            placeholder: 'Choose one',
            options: [{ key: 'a', label: 'Already picked', default: true, action: roleAction }],
          },
        },
      ],
    });

    expect(html).toContain('Already picked');
    expect(html).not.toContain('Choose one');
  });

  test('renders a row per action row', () => {
    const html = render({
      content: 'x',
      components: [
        {
          kind: 'buttons',
          buttons: [{ key: 'a', style: 'primary', label: 'A', action: roleAction }],
        },
        {
          kind: 'buttons',
          buttons: [{ key: 'b', style: 'primary', label: 'B', action: roleAction }],
        },
      ],
    });

    expect(countOf(html, 'dc-buttons')).toBe(2);
  });
});

describe('components v2', () => {
  const roleAction = { kind: 'role', mode: 'toggle', roleId: '800000000000000001' } as const;
  const TEXT = { kind: 'text', content: 'Read the **rules**' } as const;

  test('renders a text display as markdown', () => {
    const html = render({ v2: [TEXT] });

    expect(html).toContain('dc-text');
    expect(html).toContain('<strong>rules</strong>');
  });

  test('draws a separator as a rule and carries its spacing', () => {
    const html = render({ v2: [TEXT, { kind: 'separator', spacing: 'large' }] });

    expect(html).toContain('dc-separator');
    expect(html).toContain('data-divider="true"');
    expect(html).toContain('data-spacing="large"');
  });

  test('leaves a divider-less separator as space only', () => {
    const html = render({ v2: [TEXT, { kind: 'separator', divider: false }] });

    expect(html).toContain('data-divider="false"');
    expect(html).toContain('data-spacing="small"');
  });

  test('lays a gallery out by how many items it holds', () => {
    const items = Array.from({ length: 3 }, (_, i) => ({ url: `https://example.com/${i}.png` }));
    const html = render({ v2: [{ kind: 'gallery', items }] });

    expect(html).toContain('data-shape="three"');
    expect(countOf(html, 'dc-gallery-cell')).toBe(3);
    expect(countOf(html.toLowerCase(), 'referrerpolicy="no-referrer"')).toBe(3);
  });

  test('covers a spoilered gallery item', () => {
    const html = render({
      v2: [{ kind: 'gallery', items: [{ url: 'https://example.com/a.png', spoiler: true }] }],
    });

    expect(html).toContain('data-spoiler="true"');
    expect(html).toContain('dc-cover');
  });

  test('puts a section thumbnail beside its text displays', () => {
    const html = render({
      v2: [
        {
          kind: 'section',
          text: ['one', 'two'],
          accessory: { kind: 'thumbnail', url: 'https://example.com/t.png' },
        },
      ],
    });

    expect(html).toContain('dc-section-thumb');
    expect(countOf(html, 'dc-text')).toBe(2);
  });

  test('renders a section button accessory with the button markup', () => {
    const html = render({
      v2: [
        {
          kind: 'section',
          text: ['pick a role'],
          accessory: {
            kind: 'button',
            button: { key: 'go', style: 'primary', label: 'Go', action: roleAction },
          },
        },
      ],
    });

    expect(html).toContain('dc-section-accessory');
    expect(html).toContain('dc-button-primary');
    expect(html).toContain('toggle the Verified role');
  });

  test('reuses the classic row markup for a v2 row', () => {
    const html = render({
      v2: [
        {
          kind: 'row',
          row: {
            kind: 'buttons',
            buttons: [{ key: 'a', style: 'success', label: 'A', action: roleAction }],
          },
        },
      ],
    });

    expect(html).toContain('dc-buttons');
    expect(html).toContain('dc-button-success');
  });

  test('takes the container accent bar from its accent colour', () => {
    const html = render({ v2: [{ kind: 'container', accentColor: 0x5865f2, children: [TEXT] }] });

    expect(html).toContain('dc-container');
    expect(html).toContain('#5865f2');
  });

  test('falls back to a neutral container accent when none is set', () => {
    expect(render({ v2: [{ kind: 'container', children: [TEXT] }] })).toContain('#4f545c');
  });

  test('renders every child of a container', () => {
    const html = render({
      v2: [
        {
          kind: 'container',
          children: [TEXT, { kind: 'separator' }, { kind: 'text', content: 'more' }],
        },
      ],
    });

    expect(countOf(html, 'dc-text')).toBe(2);
    expect(countOf(html, 'dc-separator')).toBe(1);
  });

  test('covers a spoilered container', () => {
    const html = render({ v2: [{ kind: 'container', spoiler: true, children: [TEXT] }] });

    expect(html).toContain('data-spoiler="true"');
    expect(html).toContain('dc-cover');
  });

  // Discord returns 400 for a v2 message that also carries content or embeds, so a preview that
  // drew either would promise a message that cannot be sent.
  test('renders no content or embed markup for a v2 message', () => {
    const html = render({ v2: [{ kind: 'container', children: [TEXT] }] });

    expect(html).not.toContain('dc-content');
    expect(html).not.toContain('dc-embed');
    expect(html).not.toContain('dc-components');
  });

  test('a message that is only a v2 layout is not empty', () => {
    expect(render({ v2: [TEXT] })).not.toContain('Discord refuses a message');
  });
});

describe('the fence around the preview', () => {
  test('labels itself as a preview rather than as live Discord', () => {
    const html = render({ content: 'hello' });

    expect(html).toContain('dc-fence');
    expect(html).toContain('Discord preview');
  });

  // Every Discord colour is a --dc-* variable defined only on .dc-surface, so the design system's
  // "blurple is a doorknob" rule survives a preview that is deliberately Discord-coloured.
  test('keeps every Discord colour inside the fenced surface', () => {
    const html = render({
      content: 'hello',
      embeds: [{ title: 'x', color: 0x5865f2 }],
    });

    const surface = html.indexOf('dc-surface');
    expect(surface).toBeGreaterThan(-1);
    expect(html.slice(0, surface)).not.toContain('#5865f2');
  });
});
