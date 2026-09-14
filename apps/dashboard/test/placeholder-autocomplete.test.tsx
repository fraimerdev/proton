import { describe, expect, test } from 'bun:test';
import {
  definePlaceholderSurface,
  type PlaceholderDefinitionInput,
  placeholderValue,
  SAMPLE_NOW,
  type TemplateFieldSpec,
} from '@proton/core/placeholders';
import { TICKET_NAME_SURFACE, TICKET_WELCOME_SURFACE } from '@proton/module-tickets/placeholders';
import { WELCOME_JOIN_SURFACE, WELCOME_LEAVE_SURFACE } from '@proton/module-welcome/placeholders';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  type DynamicPlaceholder,
  dismissalFor,
  fieldAria,
  isListOpen,
  type ListKey,
  listKeyAction,
  nextDismissal,
  type OpenPlaceholder,
  openPlaceholderAt,
  placeholderReplacement,
  placeSuggestions,
  rankSuggestions,
  SUGGESTION_LIMIT,
  type SuggestionOption,
  suggestionAnnouncement,
  suggestionOptions,
  suggestionSample,
  wrapIndex,
} from '../src/components/placeholders/autocomplete.ts';
import {
  PlaceholderSuggestions,
  SuggestionList,
} from '../src/components/placeholders/placeholder-suggestions.tsx';
import type {
  PlaceholderAutocomplete,
  SuggestionRow,
} from '../src/components/placeholders/use-placeholder-autocomplete.ts';

function openAt(value: string, caret: number = value.length): OpenPlaceholder {
  const open = openPlaceholderAt(value, caret);
  if (open === null) throw new Error(`no open placeholder at ${caret} in '${value}'`);
  return open;
}

function specOf(
  surface: { id: string; fieldAt: (path: string) => TemplateFieldSpec | undefined },
  path: string,
): TemplateFieldSpec {
  const spec = surface.fieldAt(path);
  if (spec === undefined) throw new Error(`${surface.id} has no field at ${path}`);
  return spec;
}

function keysOf(options: readonly SuggestionOption[]): string[] {
  return options.map(({ key }) => key);
}

function text(
  key: string,
  label: string,
  extra: Partial<PlaceholderDefinitionInput> = {},
): PlaceholderDefinitionInput {
  return {
    key,
    label,
    group: 'Test',
    type: 'text',
    example: placeholderValue.text('Sample'),
    ...extra,
  };
}

const TEST_SURFACE = definePlaceholderSurface<null>({
  id: 'test.autocomplete',
  module: 'test',
  label: 'Test',
  event: 'member.join',
  audience: 'public',
  fields: [
    { path: 'content', kind: 'discord_text', label: 'Message text' },
    { path: 'link', kind: 'url', label: 'Link' },
  ],
  definitions: [
    text('ticket.note', 'Staff memo'),
    text('user.mention', 'Mention', {
      type: 'mention',
      example: placeholderValue.user('100000000000000001', 'Fraimer'),
    }),
    text('server.member_count', 'Member count', {
      type: 'integer',
      example: placeholderValue.integer(12),
      aliases: ['memberCount'],
    }),
    text('members.total', 'Everyone'),
    text('user.email', 'Email address', { sensitivity: 'staff_only' }),
    text('boost.count', 'Boost count', { availability: { events: ['member.boost'] } }),
    text('user.avatar_url', 'Avatar link', {
      type: 'image_url',
      example: placeholderValue.imageUrl('https://cdn.example.com/avatar.png'),
    }),
    ...Array.from({ length: 10 }, (_, index) => text(`extra.item_${index}`, `Extra ${index}`)),
  ],
  build: () => () => placeholderValue.notSet(),
  samples: [],
});

const testOptions = suggestionOptions(TEST_SURFACE, specOf(TEST_SURFACE, 'content'));

const joinContent = specOf(WELCOME_JOIN_SURFACE, 'welcomeMessage.content');

describe('openPlaceholderAt', () => {
  test('opens on a brace followed by at least one key character', () => {
    expect(openPlaceholderAt('{us', 3)).toEqual({
      start: 0,
      caret: 3,
      end: 3,
      query: 'us',
      word: 'us',
    });
    expect(openPlaceholderAt('{', 1)).toBeNull();
    expect(openPlaceholderAt('{us', 0)).toBeNull();
    expect(openPlaceholderAt('{us', 9)).toBeNull();
  });

  test('never opens on an escaped brace, but does on the brace after one', () => {
    expect(openPlaceholderAt('{{us', 4)).toBeNull();
    expect(openPlaceholderAt('{{{us', 5)?.start).toBe(2);
  });

  test('closes once the placeholder is closed, spaced or given a modifier', () => {
    expect(openPlaceholderAt('{us}', 4)).toBeNull();
    expect(openPlaceholderAt('{us}', 3)).toBeNull();
    expect(openPlaceholderAt('{us ', 4)).toBeNull();
    expect(openPlaceholderAt('{ us', 4)).toBeNull();
    expect(openPlaceholderAt('{us:upper}', 3)).toBeNull();
  });

  test('reads a dotted key after other text', () => {
    expect(openPlaceholderAt('text {user.me', 13)).toEqual({
      start: 5,
      caret: 13,
      end: 13,
      query: 'user.me',
      word: 'user.me',
    });
  });

  test('takes the rest of the word when the caret sits inside it', () => {
    expect(openPlaceholderAt('Hi {user there', 6)).toEqual({
      start: 3,
      caret: 6,
      end: 8,
      query: 'us',
      word: 'user',
    });
  });

  test('finds the placeholder at the caret among several on a line', () => {
    const line = 'Hi {user.mention}, {ser';

    expect(openPlaceholderAt(line, line.length)).toEqual({
      start: 19,
      caret: 23,
      end: 23,
      query: 'ser',
      word: 'ser',
    });
    expect(openPlaceholderAt(line, 8)).toBeNull();
  });
});

describe('suggestion ranking', () => {
  test('puts key prefixes, then aliases, then key segments, then label words', () => {
    expect(keysOf(rankSuggestions(testOptions, 'me'))).toEqual([
      'members.total',
      'server.member_count',
      'user.mention',
      'ticket.note',
    ]);
  });

  test('ignores case and lists an alias under its canonical key only', () => {
    expect(keysOf(rankSuggestions(testOptions, 'ME'))).toEqual(
      keysOf(rankSuggestions(testOptions, 'me')),
    );
    expect(keysOf(rankSuggestions(testOptions, 'memberC'))).toEqual(['server.member_count']);
    expect(keysOf(testOptions)).not.toContain('memberCount');
  });

  test('shows at most eight rows, in surface order within a tier', () => {
    const extras = rankSuggestions(testOptions, 'extra');

    expect(SUGGESTION_LIMIT).toBe(8);
    expect(keysOf(extras)).toEqual(Array.from({ length: 8 }, (_, index) => `extra.item_${index}`));
    expect(rankSuggestions(testOptions, 'extra', 3)).toHaveLength(3);
    expect(rankSuggestions(testOptions, '')).toEqual([]);
  });

  test('hides restricted and unavailable placeholders', () => {
    expect(keysOf(testOptions)).not.toContain('user.email');
    expect(keysOf(testOptions)).not.toContain('boost.count');
    expect(keysOf(rankSuggestions(testOptions, 'email'))).toEqual([]);
    expect(keysOf(rankSuggestions(testOptions, 'boost'))).toEqual([]);
  });

  test('hides what a real surface cannot know', () => {
    const join = suggestionOptions(WELCOME_JOIN_SURFACE, joinContent);
    const leave = suggestionOptions(
      WELCOME_LEAVE_SURFACE,
      specOf(WELCOME_LEAVE_SURFACE, 'goodbyeMessage.content'),
    );

    expect(keysOf(join)).toContain('user.nickname');
    expect(keysOf(leave)).not.toContain('user.nickname');
    expect(keysOf(leave)).toContain('user.username');
  });

  test('offers only values that can sit in a link in a link field', () => {
    const link = suggestionOptions(TEST_SURFACE, specOf(TEST_SURFACE, 'link'));
    expect(keysOf(rankSuggestions(link, 'user'))).toEqual(['user.avatar_url']);

    const joinLink = suggestionOptions(
      WELCOME_JOIN_SURFACE,
      specOf(WELCOME_JOIN_SURFACE, 'welcomeMessage.embeds.0.url'),
    );
    expect(keysOf(rankSuggestions(joinLink, 'avatar'))).toContain('user.avatar_url');
    expect(keysOf(joinLink)).not.toContain('user.mention');
  });

  test('finds a mention on a real surface by its last segment', () => {
    const join = suggestionOptions(WELCOME_JOIN_SURFACE, joinContent);

    expect(keysOf(rankSuggestions(join, 'men'))).toContain('user.mention');
    expect(join.every(({ key }) => !key.includes('<'))).toBe(true);
  });

  test('offers a configured form answer, only where the surface allows it', () => {
    const answers: DynamicPlaceholder[] = [
      { key: 'ticket.answer.order', label: 'Order number' },
      { key: 'ticket.number', label: 'Not dynamic' },
    ];
    const welcome = suggestionOptions(
      TICKET_WELCOME_SURFACE,
      specOf(TICKET_WELCOME_SURFACE, 'types.0.welcomeMessage'),
      answers,
    );

    expect(
      rankSuggestions(welcome, 'ord').map(({ key, label }) => ({ key, label })),
    ).toContainEqual({ key: 'ticket.answer.order', label: 'Form answer: Order number' });
    expect(keysOf(welcome).filter((key) => key === 'ticket.number')).toHaveLength(1);

    const names = suggestionOptions(
      TICKET_NAME_SURFACE,
      specOf(TICKET_NAME_SURFACE, 'namePattern'),
      answers,
    );
    expect(keysOf(names)).not.toContain('ticket.answer.order');
  });

  test('shows the sample value a member reads', () => {
    const sample = WELCOME_JOIN_SURFACE.samples[0];
    const [mention] = rankSuggestions(
      suggestionOptions(WELCOME_JOIN_SURFACE, joinContent),
      'user.mention',
    );
    if (sample === undefined || mention === undefined) throw new Error('no sample or mention');

    const lookup = WELCOME_JOIN_SURFACE.build(sample.facts, { now: SAMPLE_NOW });
    expect(suggestionSample(WELCOME_JOIN_SURFACE, joinContent, mention, lookup)).toBe('Fraimer');
  });
});

describe('placeholderReplacement', () => {
  test('replaces the typed fragment and puts the caret after the closing brace', () => {
    expect(placeholderReplacement('Hi {us', openAt('Hi {us'), 'user.mention', -1)).toEqual({
      start: 3,
      end: 6,
      token: '{user.mention}',
      value: 'Hi {user.mention}',
      caret: 17,
    });
  });

  test('swallows the rest of the word when the caret sits inside it', () => {
    const value = 'Hi {user there';
    const replaced = placeholderReplacement(value, openAt(value, 6), 'user.mention', -1);

    expect(replaced?.value).toBe('Hi {user.mention} there');
    expect(replaced?.caret).toBe(17);
  });

  test('leaves other placeholders on the line alone', () => {
    const value = 'Hi {user.mention}, {ser';
    const replaced = placeholderReplacement(value, openAt(value), 'server.name', -1);

    expect(replaced?.value).toBe('Hi {user.mention}, {server.name}');
    expect(replaced?.caret).toBe(32);
  });

  test('refuses a token that would pass the field limit', () => {
    const open = openAt('Hi {us');

    expect(placeholderReplacement('Hi {us', open, 'user.mention', 16)).toBeNull();
    expect(placeholderReplacement('Hi {us', open, 'user.mention', 17)?.value).toBe(
      'Hi {user.mention}',
    );
  });
});

describe('dismissal', () => {
  test('keeps an escaped list closed until the typed placeholder changes', () => {
    const typed = openAt('Hi {us');
    const dismissed = dismissalFor(typed);

    expect(nextDismissal(dismissed, openAt('Hi {us'))).toBe(dismissed);
    expect(nextDismissal(dismissed, openAt('Hi {us', 5))).toBe(dismissed);
    expect(nextDismissal(dismissed, null)).toBe(dismissed);
    expect(nextDismissal(dismissed, openAt('Hi {use'))).toBeNull();
    expect(nextDismissal(dismissed, openAt('Hey {us'))).toBeNull();
    expect(nextDismissal(null, typed)).toBeNull();
  });

  test('opens only with a placeholder, a match and no dismissal', () => {
    const typed = openAt('{us');

    expect(isListOpen(typed, null, 3)).toBe(true);
    expect(isListOpen(typed, null, 0)).toBe(false);
    expect(isListOpen(null, null, 3)).toBe(false);
    expect(isListOpen(typed, dismissalFor(typed), 3)).toBe(false);
    expect(isListOpen(openAt('{use'), dismissalFor(typed), 3)).toBe(true);
  });

  test('wraps the active row both ways', () => {
    expect(wrapIndex(8, 8)).toBe(0);
    expect(wrapIndex(-1, 8)).toBe(7);
    expect(wrapIndex(1, 0)).toBe(0);
  });
});

describe('list keys', () => {
  const KEY_CODES: Readonly<Record<string, number>> = {
    ArrowDown: 40,
    ArrowUp: 38,
    Enter: 13,
    Tab: 9,
    Escape: 27,
  };

  function press(key: string, extra: Partial<ListKey> = {}): ListKey {
    return {
      key,
      keyCode: KEY_CODES[key] ?? 0,
      isComposing: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      ...extra,
    };
  }

  test('maps the list keys and lets every other key through', () => {
    expect(listKeyAction(press('ArrowDown'))).toBe('next');
    expect(listKeyAction(press('ArrowUp'))).toBe('previous');
    expect(listKeyAction(press('Enter'))).toBe('accept');
    expect(listKeyAction(press('Tab'))).toBe('accept');
    expect(listKeyAction(press('Escape'))).toBe('dismiss');
    expect(listKeyAction(press('a'))).toBeUndefined();
    expect(listKeyAction(press('}'))).toBeUndefined();
    expect(listKeyAction(press(' '))).toBeUndefined();
    expect(listKeyAction(press('ArrowLeft'))).toBeUndefined();
  });

  test('never acts on a key that belongs to an IME composition', () => {
    for (const key of ['Enter', 'Tab', 'ArrowDown', 'ArrowUp', 'Escape']) {
      expect(listKeyAction(press(key, { isComposing: true }))).toBeUndefined();
      expect(listKeyAction(press(key, { isComposing: true, keyCode: 229 }))).toBeUndefined();
    }
  });

  test('ignores the Enter that commits a composition after compositionend in Safari', () => {
    expect(listKeyAction(press('Enter', { isComposing: false, keyCode: 229 }))).toBeUndefined();
    expect(listKeyAction(press('Tab', { isComposing: false, keyCode: 229 }))).toBeUndefined();
  });

  test('leaves modified keys to the field', () => {
    expect(listKeyAction(press('Tab', { shiftKey: true }))).toBeUndefined();
    expect(listKeyAction(press('Enter', { ctrlKey: true }))).toBeUndefined();
    expect(listKeyAction(press('Enter', { metaKey: true }))).toBeUndefined();
    expect(listKeyAction(press('ArrowDown', { altKey: true }))).toBeUndefined();
  });
});

describe('placement', () => {
  const viewport = { width: 1200, height: 800 };
  const size = { width: 300, height: 200 };

  test('sits below the anchor line when there is room', () => {
    const anchor = { top: 100, bottom: 130, left: 50, fieldLeft: 40, fieldWidth: 600 };

    expect(placeSuggestions(anchor, size, viewport)).toEqual({
      top: 134,
      left: 50,
      width: undefined,
      maxHeight: 360,
    });
  });

  test('flips above when the room is above, and stays inside the viewport', () => {
    const anchor = { top: 700, bottom: 730, left: 1100, fieldLeft: 40, fieldWidth: 600 };

    expect(placeSuggestions(anchor, size, viewport)).toEqual({
      top: 496,
      left: 892,
      width: undefined,
      maxHeight: 360,
    });
  });

  test('spans the field at a narrow width', () => {
    const anchor = { top: 100, bottom: 130, left: 200, fieldLeft: 16, fieldWidth: 368 };

    expect(placeSuggestions(anchor, size, { width: 400, height: 800 })).toMatchObject({
      left: 16,
      width: 368,
    });
  });
});

describe('suggestion markup', () => {
  const rows: SuggestionRow[] = [
    { key: 'user.mention', label: 'Mention', sample: 'Fraimer' },
    { key: 'server.member_count', label: 'Member count', sample: '' },
    { key: 'user.avatar_url', label: 'Avatar link', sample: undefined },
  ];

  test('renders a listbox of options with the active one selected', () => {
    const markup = renderToStaticMarkup(
      <SuggestionList
        id="list"
        label="Placeholders for message text"
        rows={rows}
        active={1}
        onChoose={() => undefined}
        onHighlight={() => undefined}
      />,
    );

    expect(markup).toContain('role="listbox"');
    expect(markup).toContain('id="list"');
    expect(markup).toContain('aria-label="Placeholders for message text"');
    expect(markup.match(/role="option"/g)).toHaveLength(3);
    expect(markup).toMatch(/id="list-option-0"[^>]*tabindex="-1"[^>]*aria-selected="false"/);
    expect(markup).toMatch(/id="list-option-1"[^>]*aria-selected="true"/);
    expect(markup).toContain('{server.member_count}');
    expect(markup).toContain('Fraimer');
    expect(markup).toContain('Empty in the sample');
    expect(markup).toContain('Avatar link');
    expect(markup).not.toContain('<input');
  });

  test('makes an input a combobox only while the list is open', () => {
    const closed = renderToStaticMarkup(
      <input {...fieldAria({ multiline: false, open: false, listId: 'list', active: 0 })} />,
    );
    expect(closed).toBe('<input aria-autocomplete="list"/>');

    const open = renderToStaticMarkup(
      <input {...fieldAria({ multiline: false, open: true, listId: 'list', active: 2 })} />,
    );
    expect(open).toContain('role="combobox"');
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('aria-controls="list"');
    expect(open).toContain('aria-activedescendant="list-option-2"');
    expect(open).toContain('aria-autocomplete="list"');
  });

  test('keeps a textarea a text box that points at the open list', () => {
    const markup = renderToStaticMarkup(
      <textarea {...fieldAria({ multiline: true, open: true, listId: 'list', active: 0 })} />,
    );

    expect(markup).not.toContain('role=');
    expect(markup).not.toContain('aria-expanded');
    expect(markup).toContain('aria-controls="list"');
    expect(markup).toContain('aria-activedescendant="list-option-0"');
    expect(markup).toContain('aria-autocomplete="list"');
  });

  test('announces the number of suggestions politely, and nothing while closed', () => {
    const autocomplete = (open: boolean): PlaceholderAutocomplete => ({
      field: {
        ref: () => undefined,
        ...fieldAria({ multiline: false, open, listId: 'list', active: 0 }),
      },
      spec: joinContent,
      open,
      listId: 'list',
      label: 'Placeholders for message text',
      rows,
      active: 0,
      fragment: null,
      element: { current: null },
      choose: () => undefined,
      highlight: () => undefined,
    });

    expect(
      renderToStaticMarkup(<PlaceholderSuggestions autocomplete={autocomplete(false)} />),
    ).toBe('<span class="visually-hidden" aria-live="polite"></span>');
    expect(
      renderToStaticMarkup(<PlaceholderSuggestions autocomplete={autocomplete(true)} />),
    ).toContain('3 placeholder suggestions');
    expect(suggestionAnnouncement(1)).toBe('1 placeholder suggestion');
  });
});
