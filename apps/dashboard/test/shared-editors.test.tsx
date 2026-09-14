import { describe, expect, mock, test } from 'bun:test';
import type { ActionRow, Embed, MessageButton, V2Component } from '@proton/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  type ConfigErrors,
  configErrors,
  EmbedEditor,
  embedFieldIssue,
  embedIssue,
  linkIssue,
  type PlaceholderSlot,
  sentence,
  summariseEmbed,
  textIssue,
} from '../src/components/discord/embed-editor.tsx';

mock.module('../src/lib/queries.ts', () => ({
  emojisQuery: (guildId: string) => ({
    queryKey: ['shared-editors', 'emojis', guildId],
    queryFn: async () => [],
  }),
}));

const { LayoutBuilder, moveItem, newLinkButton, seedComponent, summariseComponent, takenKeys } =
  await import('../src/components/discord/layout-builder.tsx');

const LINK_MISSING = 'Enter a complete http:// or https:// link.';
const SCHEMA_LINK = 'must be a complete http:// or https:// link';
const TOO_SMALL = 'Too small: expected string to have >=1 characters';

function errorsOf(entries: Record<string, string>): ConfigErrors {
  const errors = new Map(Object.entries(entries));
  return configErrors({ errors, errorAt: (path) => errors.get(path) });
}

const NONE = errorsOf({});

function recorder(paths: string[]): PlaceholderSlot {
  return (field, render) => {
    paths.push(field.path);
    return render({ suggestions: <span data-slot={field.path} /> });
  };
}

function markup(node: ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>,
  );
}

function link(key: string): MessageButton {
  return { key, style: 'link', label: 'Open', url: 'https://proton.example' };
}

const SELECT_ROW: ActionRow = {
  kind: 'select',
  select: {
    key: 'pick',
    options: [
      { key: 'one', label: 'One', action: { kind: 'reply', content: 'Hi', ephemeral: true } },
    ],
  },
};

const CONTAINER: V2Component = {
  kind: 'container',
  children: [
    { kind: 'text', content: 'Hello' },
    {
      kind: 'section',
      text: ['One', 'Two'],
      accessory: { kind: 'thumbnail', url: 'https://proton.example/a.png' },
    },
    { kind: 'section', text: ['Three'], accessory: { kind: 'button', button: link('open') } },
    {
      kind: 'gallery',
      items: [{ url: 'https://proton.example/1.png' }, { url: 'https://proton.example/2.png' }],
    },
    { kind: 'row', row: { kind: 'buttons', buttons: [link('link1')] } },
  ],
};

describe('configErrors', () => {
  test('reads one path exactly and a row from the first issue at or below it', () => {
    const errors = errorsOf({ 'm.embeds.1.url': 'bad link', 'm.embeds.10': 'empty' });

    expect(errors.at('m.embeds.1.url')).toBe('bad link');
    expect(errors.at('m.embeds.1')).toBeUndefined();
    expect(errors.under('m.embeds.1')).toBe('bad link');
    expect(errors.under('m.embeds.10')).toBe('empty');
    expect(errors.under('m.embeds.2')).toBeUndefined();
  });
});

describe('field wording', () => {
  test('turns a schema message into a sentence', () => {
    expect(sentence(SCHEMA_LINK)).toBe('Must be a complete http:// or https:// link.');
    expect(sentence('Remove it!')).toBe('Remove it!');
  });

  test('asks for a link when a reported link is empty and keeps any other report', () => {
    expect(linkIssue('  ', TOO_SMALL)).toBe(LINK_MISSING);
    expect(linkIssue('ftp://files.example', SCHEMA_LINK)).toBe(
      'Must be a complete http:// or https:// link.',
    );
    expect(linkIssue('{user}', '{user} cannot be used in a link.')).toBe(
      '{user} cannot be used in a link.',
    );
    expect(linkIssue('not a link', undefined)).toBeUndefined();
  });

  test('names an empty required text and otherwise keeps the reported message', () => {
    const empty = 'An author needs a name, or remove it.';

    expect(textIssue('  ', TOO_SMALL, empty)).toBe(empty);
    expect(textIssue('Proton', 'too big', empty)).toBe('Too big.');
    expect(textIssue('', TOO_SMALL, undefined)).toBe(`${TOO_SMALL}.`);
    expect(textIssue('', undefined, empty)).toBeUndefined();
  });

  test('says which half of an embed field is missing, once the form reports it', () => {
    const errors = errorsOf({ 'e.fields.0.name': TOO_SMALL, 'e.fields.0.value': TOO_SMALL });

    expect(embedFieldIssue({ name: '', value: ' ' }, errors, 'e.fields.0')).toBe(
      'A field needs a name and text, or remove it.',
    );
    expect(embedFieldIssue({ name: '', value: 'Be kind' }, errors, 'e.fields.0')).toBe(
      'A field needs a name, or remove it.',
    );
    expect(embedFieldIssue({ name: 'Rules', value: '' }, errors, 'e.fields.0')).toBe(
      'A field needs text, or remove it.',
    );
    expect(embedFieldIssue({ name: 'Rules', value: 'Be kind' }, errors, 'e.fields.0')).toBe(
      undefined,
    );
    expect(embedFieldIssue({ name: '', value: '' }, NONE, 'e.fields.0')).toBeUndefined();
  });
});

describe('embed rows', () => {
  test('summarise the first line that has anything in it', () => {
    expect(summariseEmbed({ title: '  ', description: 'Welcome aboard\nRead the rules' })).toBe(
      'Welcome aboard',
    );
    expect(summariseEmbed({ author: { name: 'Proton' } })).toBe('Proton');
    expect(summariseEmbed({ description: 'x'.repeat(120) })).toBe(`${'x'.repeat(90)}…`);
    expect(summariseEmbed({ title: '', footer: { text: 'Only a footer' } })).toBeUndefined();
  });

  test('explain a collapsed embed with the wording its own fields use', () => {
    const embed: Embed = { imageUrl: 'banner.png', author: { name: '' } };

    expect(embedIssue(embed, errorsOf({ 'p.0': 'this embed has nothing in it' }), 'p.0')).toBe(
      'This embed has nothing in it.',
    );
    expect(embedIssue(embed, errorsOf({ 'p.0.imageUrl': SCHEMA_LINK }), 'p.0')).toBe(
      'Must be a complete http:// or https:// link.',
    );
    expect(embedIssue(embed, errorsOf({ 'p.0.author.name': TOO_SMALL }), 'p.0')).toBe(
      'An author needs a name, or remove it.',
    );
    expect(embedIssue(embed, errorsOf({ 'p.0.title': 'too big' }), 'p.0')).toBe('Too big.');
    expect(embedIssue(embed, errorsOf({ 'p.1.imageUrl': SCHEMA_LINK }), 'p.0')).toBeUndefined();
    expect(embedIssue(embed, NONE, 'p.0')).toBeUndefined();
  });
});

describe('EmbedEditor', () => {
  const embed: Embed = {
    title: 'Welcome',
    description: 'Read the rules',
    author: { name: 'Proton' },
    footer: { text: 'See you around' },
    fields: [{ name: 'Rules', value: 'Be kind' }],
  };

  test('offers a placeholder slot on every text field, at its config path', () => {
    const paths: string[] = [];
    const html = markup(
      <EmbedEditor
        value={[embed]}
        prefix="welcomeMessage.embeds"
        errors={NONE}
        placeholders={recorder(paths)}
        onChange={() => undefined}
      />,
    );

    const at = (field: string): string => `welcomeMessage.embeds.0.${field}`;

    expect(paths).toEqual([
      at('title'),
      at('url'),
      at('description'),
      at('imageUrl'),
      at('thumbnailUrl'),
      at('author.name'),
      at('author.url'),
      at('author.iconUrl'),
      at('footer.text'),
      at('footer.iconUrl'),
      at('fields.0.name'),
      at('fields.0.value'),
    ]);
    expect(html).toContain(`data-slot="${at('fields.0.value')}"`);
  });

  test('renders plain fields when the page offers no placeholders', () => {
    const html = markup(
      <EmbedEditor
        value={[embed]}
        prefix="panel.embeds"
        errors={NONE}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="Embed title"');
    expect(html).not.toContain('aria-autocomplete');
  });

  test('marks nothing until the form reports an issue, then names it', () => {
    const broken: Embed = { imageUrl: 'banner.png', fields: [{ name: '', value: '' }] };
    const render = (errors: ConfigErrors): string =>
      markup(
        <EmbedEditor
          value={[broken]}
          prefix="panel.embeds"
          errors={errors}
          onChange={() => undefined}
        />,
      );

    const quiet = render(NONE);
    expect(quiet).not.toContain('A field needs');
    expect(quiet).not.toContain('Must be a complete');
    expect(quiet).not.toContain('aria-invalid="true"');

    const reported = render(
      errorsOf({
        'panel.embeds.0.imageUrl': SCHEMA_LINK,
        'panel.embeds.0.fields.0.name': TOO_SMALL,
        'panel.embeds.0.fields.0.value': TOO_SMALL,
      }),
    );
    expect(reported).toContain('A field needs a name and text, or remove it.');
    expect(reported).toContain('Must be a complete http:// or https:// link.');
    expect(reported).toContain('aria-invalid="true"');
  });

  test('leaves an issue to the placeholder diagnostics that already show it', () => {
    const message = '{user} cannot be used in a link.';
    const slot: PlaceholderSlot = (field, render) =>
      render(
        field.path.endsWith('.url')
          ? {
              diagnostics: <span data-diagnostics="">{message}</span>,
              diagnosticMessages: [message],
            }
          : {},
      );

    const html = markup(
      <EmbedEditor
        value={[{ title: 'Hi', url: '{user}' }]}
        prefix="p"
        errors={errorsOf({ 'p.0.url': message })}
        placeholders={slot}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain('data-diagnostics');
    expect(html).not.toContain(`<p class="field-error" role="alert">${message}</p>`);
  });
});

describe('layout helpers', () => {
  test('move one item without touching the original', () => {
    const items = ['a', 'b', 'c'];

    expect(moveItem(items, 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(items, 2, 3)).toEqual(['a', 'b', 'c']);
    expect(moveItem(items, 0, -1)).not.toBe(items);
    expect(items).toEqual(['a', 'b', 'c']);
  });

  test('collect every key a press could carry, at both levels', () => {
    const layout: V2Component[] = [
      { kind: 'row', row: { kind: 'buttons', buttons: [link('top')] } },
      CONTAINER,
      { kind: 'row', row: SELECT_ROW },
    ];

    expect(takenKeys(layout)).toEqual(new Set(['top', 'open', 'link1', 'pick']));
  });

  test('seed a link button under a key nothing else holds', () => {
    expect(newLinkButton(new Set(['link1', 'link2']))).toEqual({
      key: 'link3',
      style: 'link',
      label: 'Open',
      url: '',
    });

    expect(seedComponent('row', new Set(['link1']), undefined)).toEqual({
      kind: 'row',
      row: { kind: 'buttons', buttons: [{ key: 'link2', style: 'link', label: 'Open', url: '' }] },
    });
  });

  test('seed a container with the page accent only when the page has one', () => {
    expect(seedComponent('container', new Set(), 0xff7a86)).toEqual({
      kind: 'container',
      accentColor: 0xff7a86,
      children: [{ kind: 'text', content: '' }],
    });

    expect('accentColor' in seedComponent('container', new Set(), undefined)).toBe(false);
  });

  test('summarise a component for its collapsed row', () => {
    expect(summariseComponent({ kind: 'text', content: 'First\nSecond' })).toBe('First');
    expect(summariseComponent({ kind: 'gallery', items: [{ url: 'https://a.example' }] })).toBe(
      '1 image',
    );
    expect(summariseComponent(CONTAINER)).toBe('5 inside');
    expect(summariseComponent({ kind: 'separator', divider: false, spacing: 'small' })).toBe(
      'Blank space',
    );
    expect(summariseComponent({ kind: 'row', row: SELECT_ROW })).toBe('A dropdown');
  });
});

describe('LayoutBuilder', () => {
  const child = (rest: string): string => `noticeLayout.v2.0.children.${rest}`;

  test('offers a placeholder slot on every text field, at its config path', () => {
    const paths: string[] = [];
    const html = markup(
      <LayoutBuilder
        guildId="1"
        value={[CONTAINER]}
        prefix="noticeLayout.v2"
        errors={NONE}
        placeholders={recorder(paths)}
        onChange={() => undefined}
      />,
    );

    expect(paths).toEqual([
      child('0.content'),
      child('1.text.0'),
      child('1.text.1'),
      child('1.accessory.url'),
      child('1.accessory.description'),
      child('2.text.0'),
      child('2.accessory.button.label'),
      child('2.accessory.button.url'),
      child('3.items.0.url'),
      child('3.items.0.description'),
      child('3.items.1.url'),
      child('3.items.1.description'),
      child('4.row.buttons.0.label'),
      child('4.row.buttons.0.url'),
    ]);
    expect(html).toContain('aria-label="Move Text down"');
  });

  test('never offers a slot on the text Proton replaces when it posts', () => {
    const paths: string[] = [];
    const html = markup(
      <LayoutBuilder
        guildId="1"
        value={[CONTAINER]}
        prefix="noticeLayout.v2"
        errors={NONE}
        placeholders={recorder(paths)}
        overriddenAt={(path) =>
          path === child('0') ? { content: 'Replaced wording', note: 'Swapped in' } : undefined
        }
        onChange={() => undefined}
      />,
    );

    expect(paths).not.toContain(child('0.content'));
    expect(html).toContain('Replaced wording');
  });

  test('names a bad image link only once the form reports it', () => {
    const gallery: V2Component[] = [{ kind: 'gallery', items: [{ url: '' }] }];
    const render = (errors: ConfigErrors): string =>
      markup(
        <LayoutBuilder
          guildId="1"
          value={gallery}
          prefix="v2"
          errors={errors}
          onChange={() => undefined}
        />,
      );

    expect(render(NONE)).not.toContain(LINK_MISSING);
    expect(render(errorsOf({ 'v2.0.items.0.url': TOO_SMALL }))).toContain(LINK_MISSING);
  });

  test('asks for a dropdown row to be removed', () => {
    const html = markup(
      <LayoutBuilder
        guildId="1"
        value={[{ kind: 'row', row: SELECT_ROW }]}
        prefix="v2"
        errors={NONE}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain('This row is a dropdown');
  });
});
