import { describe, expect, test } from 'bun:test';
import {
  definePlaceholderSurface,
  type PlaceholderDefinitionInput,
  placeholderValue,
  SAMPLE_NOW,
  type SurfaceDiagnostic,
  type TemplateFieldSpec,
} from '@proton/core/placeholders';
import { TICKET_NAME_SURFACE, TICKET_WELCOME_SURFACE } from '@proton/module-tickets/placeholders';
import { WELCOME_JOIN_SURFACE, WELCOME_LEAVE_SURFACE } from '@proton/module-welcome/placeholders';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  BROWSE_LIMIT,
  type DynamicPlaceholder,
  dismissalFor,
  emptyMessage,
  fieldAria,
  groupSuggestions,
  interceptsKey,
  isListOpen,
  type ListKey,
  listKeyAction,
  MATCH_LIMIT,
  MODIFIER_GROUP,
  modifierOptions,
  nextDismissal,
  type OpenPlaceholder,
  openPlaceholderAt,
  pendingSpan,
  placeSuggestions,
  rankSuggestions,
  type SuggestionOption,
  suggestionAnnouncement,
  suggestionDetail,
  suggestionOptions,
  suggestionReplacement,
  suggestionSample,
  wrapIndex,
} from '../src/components/placeholders/autocomplete.ts';
import {
  PlaceholderSuggestions,
  SuggestionList,
} from '../src/components/placeholders/placeholder-suggestions.tsx';
import {
  elsewhereMessage,
  unknownKeyAt,
  visibleDiagnostics,
} from '../src/components/placeholders/template-diagnostics.tsx';
import type {
  PlaceholderAutocomplete,
  SuggestionRowGroup,
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
    text('ticket.note', 'Staff memo', {
      group: 'Ticket',
      description: 'What staff wrote about it',
    }),
    text('user.mention', 'Mention', {
      group: 'Member',
      type: 'mention',
      example: placeholderValue.user('100000000000000001', 'Fraimer'),
    }),
    text('server.member_count', 'Member count', {
      group: 'Server',
      type: 'integer',
      example: placeholderValue.integer(12),
      aliases: ['memberCount'],
    }),
    text('members.total', 'Everyone', { group: 'Server' }),
    text('user.email', 'Email address', { sensitivity: 'staff_only' }),
    text('boost.count', 'Boost count', { availability: { events: ['member.boost'] } }),
    text('user.avatar_url', 'Avatar link', {
      group: 'Member',
      keywords: ['pfp'],
      type: 'image_url',
      example: placeholderValue.imageUrl('https://cdn.example.com/avatar.png'),
    }),
    text('user.joined_at', 'Joined', {
      group: 'Member',
      type: 'datetime',
      example: placeholderValue.datetime(Date.UTC(2026, 0, 1)),
    }),
    ...Array.from({ length: 10 }, (_, index) => text(`extra.item_${index}`, `Extra ${index}`)),
  ],
  build: () => () => placeholderValue.notSet(),
  samples: [],
});

const content = specOf(TEST_SURFACE, 'content');

const testOptions = suggestionOptions(TEST_SURFACE, content);

const joinContent = specOf(WELCOME_JOIN_SURFACE, 'welcomeMessage.content');

describe('openPlaceholderAt', () => {
  test('opens on a bare brace, with nothing typed yet', () => {
    expect(openPlaceholderAt('{', 1)).toEqual({
      kind: 'placeholder',
      token: 0,
      start: 0,
      caret: 1,
      end: 1,
      query: '',
      word: '',
      closed: false,
      key: '',
      previous: [],
      prefix: '',
    });
    expect(openAt('Hi {').start).toBe(3);
    expect(openAt('{us').query).toBe('us');
    expect(openPlaceholderAt('{us', 0)).toBeNull();
    expect(openPlaceholderAt('{us', 9)).toBeNull();
  });

  test('never opens on an escaped brace, but does on the brace after one', () => {
    expect(openPlaceholderAt('{{', 2)).toBeNull();
    expect(openPlaceholderAt('{{', 1)).toBeNull();
    expect(openPlaceholderAt('{{us', 4)).toBeNull();
    expect(openAt('{{{us').start).toBe(2);
  });

  test('searches inside a closed placeholder, but not past its brace', () => {
    expect(openAt('{us}', 3)).toMatchObject({ start: 0, end: 3, word: 'us', closed: true });
    expect(openAt('{user.name}', 1)).toMatchObject({ query: '', word: 'user.name', closed: true });
    expect(openAt('{us:upper}', 3)).toMatchObject({ kind: 'placeholder', closed: true });
    expect(openPlaceholderAt('{us}', 4)).toBeNull();
  });

  test('closes once the placeholder is spaced', () => {
    expect(openPlaceholderAt('{us ', 4)).toBeNull();
    expect(openPlaceholderAt('{ us', 4)).toBeNull();
    expect(openPlaceholderAt('{ ', 2)).toBeNull();
  });

  test('reads a dotted key after other text, and takes the rest of the word', () => {
    expect(openAt('text {user.me')).toMatchObject({ start: 5, query: 'user.me', word: 'user.me' });
    expect(openAt('Hi {user there', 6)).toMatchObject({
      start: 3,
      end: 8,
      query: 'us',
      word: 'user',
      closed: false,
    });
  });

  test('finds the placeholder at the caret among several on a line', () => {
    const line = 'Hi {user.mention}, {ser';

    expect(openAt(line)).toMatchObject({ start: 19, caret: 23, query: 'ser' });
    expect(openPlaceholderAt(line, 17)).toBeNull();
  });
});

describe('modifier fragments', () => {
  test('open after the colon that follows a placeholder name', () => {
    expect(openAt('{user.name:')).toEqual({
      kind: 'modifier',
      token: 0,
      start: 11,
      caret: 11,
      end: 11,
      query: '',
      word: '',
      closed: false,
      key: 'user.name',
      previous: [],
      prefix: 'user.name',
    });
    expect(openAt('Hi {user.name:up')).toMatchObject({ start: 14, query: 'up', key: 'user.name' });
  });

  test('carry the modifiers already applied, arguments and all', () => {
    expect(openAt('{user.name:upper:lo')).toMatchObject({
      previous: ['upper'],
      prefix: 'user.name:upper',
    });

    const quoted = '{user.name:fallback("a:b{c}"):u';
    expect(openAt(quoted)).toMatchObject({
      previous: ['fallback'],
      prefix: 'user.name:fallback("a:b{c}")',
    });
    expect(openAt('{user.name:truncate(40):u').prefix).toBe('user.name:truncate(40)');
  });

  test('take the whole name, and its arguments, when the caret is inside', () => {
    expect(openAt('{user.name:upper}', 13)).toMatchObject({
      start: 11,
      end: 16,
      word: 'upper',
      closed: true,
    });
    expect(openAt('{user.name:truncate(40)}', 13)).toMatchObject({ end: 23, closed: true });
  });

  test('never open outside a placeholder', () => {
    expect(openPlaceholderAt('Time: 5pm', 5)).toBeNull();
    expect(openPlaceholderAt('{{user:up', 9)).toBeNull();
    expect(openPlaceholderAt('{user name:up', 13)).toBeNull();
    expect(openPlaceholderAt(':', 1)).toBeNull();
  });
});

describe('suggestion options', () => {
  test('carry the description, category and keywords from the registry', () => {
    const note = testOptions.find(({ key }) => key === 'ticket.note');

    expect(note).toMatchObject({
      kind: 'placeholder',
      insert: 'ticket.note',
      token: '{ticket.note}',
      label: 'Staff memo',
      description: 'What staff wrote about it',
      group: 'Ticket',
    });
    expect(testOptions.find(({ key }) => key === 'user.avatar_url')?.keywords).toEqual(['pfp']);
  });

  test('hide restricted and unavailable placeholders', () => {
    expect(keysOf(testOptions)).not.toContain('user.email');
    expect(keysOf(testOptions)).not.toContain('boost.count');
  });

  test('hide what a real surface cannot know', () => {
    const join = suggestionOptions(WELCOME_JOIN_SURFACE, joinContent);
    const leave = suggestionOptions(
      WELCOME_LEAVE_SURFACE,
      specOf(WELCOME_LEAVE_SURFACE, 'goodbyeMessage.content'),
    );

    expect(keysOf(join)).toContain('user.nickname');
    expect(keysOf(leave)).not.toContain('user.nickname');
    expect(keysOf(leave)).toContain('user.username');
  });

  test('offer only values that can sit in a link in a link field', () => {
    const link = suggestionOptions(TEST_SURFACE, specOf(TEST_SURFACE, 'link'));
    expect(keysOf(rankSuggestions(link, 'user'))).toEqual(['user.avatar_url']);

    const joinLink = suggestionOptions(
      WELCOME_JOIN_SURFACE,
      specOf(WELCOME_JOIN_SURFACE, 'welcomeMessage.embeds.0.url'),
    );
    expect(keysOf(rankSuggestions(joinLink, 'avatar'))).toContain('user.avatar_url');
    expect(keysOf(joinLink)).not.toContain('user.mention');
  });

  test('offer only whole links at the start of a link field', () => {
    const link = specOf(TEST_SURFACE, 'link');

    expect(keysOf(suggestionOptions(TEST_SURFACE, link, [], true))).toEqual(['user.avatar_url']);
    expect(keysOf(suggestionOptions(TEST_SURFACE, link))).toContain('ticket.note');

    const joinThumbnail = specOf(WELCOME_JOIN_SURFACE, 'welcomeMessage.embeds.0.thumbnailUrl');
    const whole = keysOf(suggestionOptions(WELCOME_JOIN_SURFACE, joinThumbnail, [], true));
    expect(whole).toContain('user.avatar_url');
    expect(whole).toContain('server.icon_url');
    expect(whole).not.toContain('user.username');
  });

  test('offer a configured form answer, only where the surface allows it', () => {
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

  test('list every placeholder in the field for a bare brace', () => {
    expect(keysOf(rankSuggestions(testOptions, ''))).toEqual(keysOf(testOptions));
    expect(BROWSE_LIMIT).toBeGreaterThanOrEqual(100);
    expect(join().every(({ key }) => !key.includes('<'))).toBe(true);

    function join(): SuggestionOption[] {
      return suggestionOptions(WELCOME_JOIN_SURFACE, joinContent);
    }
  });
});

describe('modifier options', () => {
  function names(key: string, previous: string[] = [], spec = content): string[] {
    return keysOf(modifierOptions(TEST_SURFACE, spec, { key, previous }));
  }

  test('fit the placeholder’s type', () => {
    expect(names('ticket.note')).toEqual(['upper', 'lower', 'truncate', 'slug', 'fallback']);
    expect(names('server.member_count')).toEqual([
      'number',
      'compact',
      'ordinal',
      'percent',
      'fallback',
    ]);
    expect(names('user.joined_at')).toEqual([
      'relative',
      'full',
      'date',
      'time',
      'unix',
      'fallback',
    ]);
  });

  test('follow the chain already typed, and never repeat a modifier', () => {
    expect(names('ticket.note', ['upper'])).toEqual(['lower', 'truncate', 'slug', 'fallback']);
    expect(names('user.joined_at', ['date'])).toEqual(['fallback']);
    expect(names('ticket.note', ['fallback'])).not.toContain('fallback');
  });

  test('drop readable-text modifiers from a link and offer nothing for an unknown key', () => {
    expect(names('user.avatar_url', [], specOf(TEST_SURFACE, 'link'))).toEqual(['fallback']);
    expect(names('user.nothing')).toEqual([]);
  });

  test('insert the documented usage, with an example argument', () => {
    const options = modifierOptions(TEST_SURFACE, content, { key: 'ticket.note', previous: [] });

    expect(options.map(({ insert }) => insert)).toEqual([
      'upper',
      'lower',
      'truncate(40)',
      'slug',
      'fallback("nobody")',
    ]);
    expect(options.every(({ group }) => group === MODIFIER_GROUP)).toBe(true);
    expect(options.find(({ key }) => key === 'upper')?.description).toBe('All capital letters.');
  });
});

describe('suggestion ranking', () => {
  test('puts exact names first, then name prefixes, aliases, segments, labels and categories', () => {
    expect(keysOf(rankSuggestions(testOptions, 'me'))).toEqual([
      'members.total',
      'server.member_count',
      'user.mention',
      'ticket.note',
      'user.avatar_url',
      'user.joined_at',
    ]);
    expect(keysOf(rankSuggestions(testOptions, 'user.mention'))[0]).toBe('user.mention');
  });

  test('also matches keywords and description words', () => {
    expect(keysOf(rankSuggestions(testOptions, 'pfp'))).toEqual(['user.avatar_url']);
    expect(keysOf(rankSuggestions(testOptions, 'wrote'))).toEqual(['ticket.note']);
    expect(keysOf(rankSuggestions(testOptions, 'zzz'))).toEqual([]);
  });

  test('ignores case and lists an alias under its canonical key only', () => {
    expect(keysOf(rankSuggestions(testOptions, 'ME'))).toEqual(
      keysOf(rankSuggestions(testOptions, 'me')),
    );
    expect(keysOf(rankSuggestions(testOptions, 'memberC'))).toEqual(['server.member_count']);
    expect(keysOf(testOptions)).not.toContain('memberCount');
  });

  test('caps a search, in surface order within a tier', () => {
    expect(MATCH_LIMIT).toBe(40);
    expect(keysOf(rankSuggestions(testOptions, 'extra'))).toEqual(
      Array.from({ length: 10 }, (_, index) => `extra.item_${index}`),
    );
    expect(rankSuggestions(testOptions, 'extra', 3)).toHaveLength(3);
  });

  test('groups the ranked matches by category, best category first', () => {
    const groups = groupSuggestions(rankSuggestions(testOptions, 'me'));

    expect(groups.map(({ label, options }) => [label, keysOf(options)])).toEqual([
      ['Server', ['members.total', 'server.member_count']],
      ['Member', ['user.mention', 'user.avatar_url', 'user.joined_at']],
      ['Ticket', ['ticket.note']],
    ]);
  });

  test('ranks modifiers by name, then by what they do', () => {
    const options = modifierOptions(TEST_SURFACE, content, { key: 'ticket.note', previous: [] });

    expect(keysOf(rankSuggestions(options, 'up'))).toEqual(['upper']);
    expect(keysOf(rankSuggestions(options, 'cap'))).toEqual(['upper']);
    expect(keysOf(rankSuggestions(options, 'dash'))).toEqual(['slug']);
  });
});

describe('samples and details', () => {
  const sample = WELCOME_JOIN_SURFACE.samples[0];
  if (sample === undefined) throw new Error('the welcome surface has no sample');
  const lookup = WELCOME_JOIN_SURFACE.build(sample.facts, { now: SAMPLE_NOW });
  const join = suggestionOptions(WELCOME_JOIN_SURFACE, joinContent);

  test('shows the sample value a member reads', () => {
    const [mention] = rankSuggestions(join, 'user.mention');
    if (mention === undefined) throw new Error('no mention');

    expect(suggestionSample(WELCOME_JOIN_SURFACE, joinContent, mention, lookup)).toBe('Fraimer');
  });

  test('renders a modifier on the placeholder it follows', () => {
    const [username] = rankSuggestions(join, 'user.username');
    const upper = modifierOptions(WELCOME_JOIN_SURFACE, joinContent, {
      key: 'user.username',
      previous: [],
    }).find(({ key }) => key === 'upper');
    if (username === undefined || upper === undefined) throw new Error('missing options');

    const plain = suggestionSample(WELCOME_JOIN_SURFACE, joinContent, username, lookup);
    expect(
      suggestionSample(WELCOME_JOIN_SURFACE, joinContent, upper, lookup, {
        prefix: 'user.username',
      }),
    ).toBe(plain.toUpperCase());
  });

  test('explains a placeholder in the detail area, without repeating the row', () => {
    const avatar = testOptions.find(({ key }) => key === 'user.avatar_url');
    const count = testOptions.find(({ key }) => key === 'server.member_count');
    if (avatar === undefined || count === undefined) throw new Error('missing options');

    expect(suggestionDetail(count, content)).toEqual([
      'Also works as {memberCount}.',
      'Type : after the name to change how it’s shown.',
    ]);
    expect(suggestionDetail(avatar, specOf(TEST_SURFACE, 'link'))).toEqual([]);
  });

  test('repeats a description in the detail area only when the row cuts it short', () => {
    const [roles] = rankSuggestions(join, 'user.role_mentions');
    const [username] = rankSuggestions(join, 'user.username');
    if (roles === undefined || username === undefined) throw new Error('missing options');

    expect(suggestionDetail(roles, joinContent)[0]).toBe(roles.description);
    expect(suggestionDetail(username, joinContent)).not.toContain(username.description);
  });
});

describe('suggestionReplacement', () => {
  const mention = { insert: 'user.mention' };

  test('replaces the typed fragment and puts the caret after the closing brace', () => {
    expect(suggestionReplacement('Hi {us', openAt('Hi {us'), mention, -1)).toEqual({
      start: 3,
      end: 6,
      text: '{user.mention}',
      value: 'Hi {user.mention}',
      caret: 17,
    });
    expect(suggestionReplacement('Hi {', openAt('Hi {'), mention, -1)?.value).toBe(
      'Hi {user.mention}',
    );
  });

  test('swallows the rest of the word when the caret sits inside it', () => {
    const value = 'Hi {user there';
    const replaced = suggestionReplacement(value, openAt(value, 6), mention, -1);

    expect(replaced?.value).toBe('Hi {user.mention} there');
    expect(replaced?.caret).toBe(17);
  });

  test('keeps an existing closing brace and any modifiers after it', () => {
    const closed = suggestionReplacement('Hi {us} there', openAt('Hi {us} there', 5), mention, -1);
    expect(closed?.value).toBe('Hi {user.mention} there');
    expect(closed?.caret).toBe(17);

    const shaped = suggestionReplacement('{us:upper}!', openAt('{us:upper}!', 3), mention, -1);
    expect(shaped?.value).toBe('{user.mention:upper}!');
    expect(shaped?.caret).toBe(20);
  });

  test('inserts a modifier and closes the placeholder once', () => {
    const open = suggestionReplacement(
      '{user.name:up',
      openAt('{user.name:up'),
      { insert: 'upper' },
      -1,
    );
    expect(open?.value).toBe('{user.name:upper}');
    expect(open?.caret).toBe(17);

    const closed = suggestionReplacement(
      '{user.name:up}',
      openAt('{user.name:up}', 13),
      { insert: 'upper' },
      -1,
    );
    expect(closed?.value).toBe('{user.name:upper}');
    expect(closed?.caret).toBe(17);

    const chained = suggestionReplacement(
      '{user.name:up:truncate(5)} x',
      openAt('{user.name:up:truncate(5)} x', 13),
      { insert: 'upper' },
      -1,
    );
    expect(chained?.value).toBe('{user.name:upper:truncate(5)} x');
    expect(chained?.caret).toBe(29);
  });

  test('leaves other placeholders on the line alone', () => {
    const value = 'Hi {user.mention}, {ser';
    const replaced = suggestionReplacement(value, openAt(value), { insert: 'server.name' }, -1);

    expect(replaced?.value).toBe('Hi {user.mention}, {server.name}');
    expect(replaced?.caret).toBe(32);
  });

  test('refuses a token that would pass the field limit', () => {
    const open = openAt('Hi {us');

    expect(suggestionReplacement('Hi {us', open, mention, 16)).toBeNull();
    expect(suggestionReplacement('Hi {us', open, mention, 17)?.value).toBe('Hi {user.mention}');
  });

  test('marks the whole placeholder being edited as pending', () => {
    expect(pendingSpan('Hi {us', openAt('Hi {us'))).toEqual({ start: 3, end: 6 });
    expect(pendingSpan('Hi {us} x', openAt('Hi {us} x', 5))).toEqual({ start: 3, end: 7 });
    expect(pendingSpan('{a:up}', openAt('{a:up}', 5))).toEqual({ start: 0, end: 6 });
  });
});

describe('dismissal', () => {
  test('keeps an escaped list closed until the typed fragment changes', () => {
    const typed = openAt('Hi {us');
    const dismissed = dismissalFor(typed);

    expect(nextDismissal(dismissed, openAt('Hi {us'))).toBe(dismissed);
    expect(nextDismissal(dismissed, openAt('Hi {us', 5))).toBe(dismissed);
    expect(nextDismissal(dismissed, null)).toBe(dismissed);
    expect(nextDismissal(dismissed, openAt('Hi {use'))).toBeNull();
    expect(nextDismissal(dismissed, openAt('Hey {us'))).toBeNull();
    expect(nextDismissal(null, typed)).toBeNull();
  });

  test('opens with any fragment, even one that matches nothing', () => {
    const typed = openAt('{zzz');

    expect(isListOpen(typed, null)).toBe(true);
    expect(isListOpen(null, null)).toBe(false);
    expect(isListOpen(typed, dismissalFor(typed))).toBe(false);
    expect(isListOpen(openAt('{zzzz'), dismissalFor(typed))).toBe(true);
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

  test('maps the list keys and leaves Tab to move between fields', () => {
    expect(listKeyAction(press('ArrowDown'))).toBe('next');
    expect(listKeyAction(press('ArrowUp'))).toBe('previous');
    expect(listKeyAction(press('Enter'))).toBe('accept');
    expect(listKeyAction(press('Escape'))).toBe('dismiss');
    expect(listKeyAction(press('Tab'))).toBeUndefined();
    expect(listKeyAction(press('a'))).toBeUndefined();
    expect(listKeyAction(press('}'))).toBeUndefined();
    expect(listKeyAction(press('ArrowLeft'))).toBeUndefined();
  });

  test('only takes Enter and the arrows while a suggestion is there to pick', () => {
    expect(interceptsKey('accept', 0)).toBe(false);
    expect(interceptsKey('next', 0)).toBe(false);
    expect(interceptsKey('dismiss', 0)).toBe(true);
    expect(interceptsKey('accept', 3)).toBe(true);
  });

  test('never acts on a key that belongs to an IME composition', () => {
    for (const key of ['Enter', 'ArrowDown', 'ArrowUp', 'Escape']) {
      expect(listKeyAction(press(key, { isComposing: true }))).toBeUndefined();
      expect(listKeyAction(press(key, { isComposing: true, keyCode: 229 }))).toBeUndefined();
    }
    expect(listKeyAction(press('Enter', { isComposing: false, keyCode: 229 }))).toBeUndefined();
  });

  test('leaves modified keys to the field', () => {
    expect(listKeyAction(press('Enter', { shiftKey: true }))).toBeUndefined();
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

  test('stays above an on-screen keyboard', () => {
    const anchor = { top: 380, bottom: 410, left: 16, fieldLeft: 16, fieldWidth: 368 };
    const keyboard = { width: 400, height: 420, top: 0 };

    const placed = placeSuggestions(anchor, size, keyboard);
    expect(placed.top + Math.min(size.height, placed.maxHeight)).toBeLessThanOrEqual(420);
  });
});

describe('suggestion markup', () => {
  const groups: SuggestionRowGroup[] = [
    {
      label: 'Member',
      rows: [
        { id: 'a', index: 0, token: '{user.mention}', label: 'Pings them', sample: 'Fraimer' },
        { id: 'b', index: 1, token: '{user.avatar_url}', label: 'Avatar', sample: undefined },
      ],
    },
    {
      label: 'Server',
      rows: [{ id: 'c', index: 2, token: '{server.member_count}', label: 'Members', sample: '' }],
    },
  ];

  function list(active: number, detail: string[] = []): string {
    return renderToStaticMarkup(
      <SuggestionList
        id="list"
        label="Placeholders for message text"
        kind="placeholder"
        groups={groups}
        active={active}
        detail={detail}
        onChoose={() => undefined}
        onHighlight={() => undefined}
      />,
    );
  }

  test('renders a grouped listbox of options with the active one selected', () => {
    const markup = list(2);

    expect(markup).toContain('role="listbox"');
    expect(markup).toContain('id="list"');
    expect(markup).toContain('aria-label="Placeholders for message text"');
    expect(markup.match(/role="group"/g)).toHaveLength(2);
    expect(markup).toContain('id="list-group-0"');
    expect(markup).toContain('aria-labelledby="list-group-1"');
    expect(markup.match(/role="option"/g)).toHaveLength(3);
    expect(markup).toMatch(/id="list-option-0"[^>]*tabindex="-1"[^>]*aria-selected="false"/);
    expect(markup).toMatch(/id="list-option-2"[^>]*aria-selected="true"/);
    expect(markup).toContain('{server.member_count}');
    expect(markup).toContain('Sample: </span>Fraimer');
    expect(markup).toContain('Empty in the sample');
    expect(markup).not.toContain('<input');
  });

  test('describes the active option from the detail area', () => {
    const markup = list(0, ['Pings them where mentions are allowed.']);

    expect(markup).toMatch(/id="list-option-0"[^>]*aria-describedby="list-detail"/);
    expect(markup).not.toMatch(/id="list-option-1"[^>]*aria-describedby/);
    expect(markup).toContain('id="list-detail"');
    expect(markup).toContain('Pings them where mentions are allowed.');
  });

  test('says so when nothing matches, without an empty listbox', () => {
    const empty = renderToStaticMarkup(
      <SuggestionList
        id="list"
        label="Modifiers"
        kind="modifier"
        groups={[]}
        active={0}
        detail={[]}
        onChoose={() => undefined}
        onHighlight={() => undefined}
      />,
    );

    expect(empty).toContain('No matching modifiers.');
    expect(empty).not.toContain('role="listbox"');
    expect(emptyMessage('placeholder')).toBe('No matching placeholders.');
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
  });

  test('keeps a textarea a text box that points at the open list', () => {
    const markup = renderToStaticMarkup(
      <textarea {...fieldAria({ multiline: true, open: true, listId: 'list', active: 0 })} />,
    );

    expect(markup).not.toContain('role=');
    expect(markup).not.toContain('aria-expanded');
    expect(markup).toContain('aria-controls="list"');
    expect(markup).toContain('aria-activedescendant="list-option-0"');
  });

  test('announces suggestions politely, an empty search too, and nothing while closed', () => {
    const autocomplete = (open: boolean, count: number): PlaceholderAutocomplete => ({
      field: {
        ref: () => undefined,
        ...fieldAria({ multiline: false, open, listId: 'list', active: 0 }),
      },
      spec: joinContent,
      open,
      kind: 'placeholder',
      listId: 'list',
      label: 'Placeholders for message text',
      groups: [],
      rows: groups.flatMap(({ rows }) => rows).slice(0, count),
      active: 0,
      detail: [],
      fragment: null,
      pending: null,
      hint: false,
      text: '',
      element: { current: null },
      choose: () => undefined,
      highlight: () => undefined,
    });

    expect(
      renderToStaticMarkup(<PlaceholderSuggestions autocomplete={autocomplete(false, 3)} />),
    ).toBe('<span class="visually-hidden" aria-live="polite"></span>');
    expect(
      renderToStaticMarkup(<PlaceholderSuggestions autocomplete={autocomplete(true, 3)} />),
    ).toContain('3 placeholder suggestions');
    expect(
      renderToStaticMarkup(<PlaceholderSuggestions autocomplete={autocomplete(true, 0)} />),
    ).toContain('No matching placeholders.');
    expect(suggestionAnnouncement(1, 'modifier')).toBe('1 modifier suggestion');
  });
});

describe('diagnostics while typing', () => {
  function diagnostic(start: number, end: number, message: string): SurfaceDiagnostic {
    return { code: 'unknown_placeholder', severity: 'warning', message, span: { start, end } };
  }

  test('hides what is still being typed, and shows it once the caret leaves', () => {
    const typing = diagnostic(3, 7, '{use} isn’t a placeholder here.');
    const done = diagnostic(10, 15, '{xyz} isn’t a placeholder here.');

    expect(visibleDiagnostics([typing, done], { start: 3, end: 7 }).shown).toEqual([done]);
    expect(visibleDiagnostics([typing, done], null).shown).toEqual([typing, done]);
  });

  test('names where a placeholder from another message works', () => {
    expect(unknownKeyAt('Hi {level.current:upper}!', { start: 3, end: 24 })).toBe('level.current');
    expect(unknownKeyAt('Hi there', { start: 0, end: 2 })).toBeUndefined();
    expect(elsewhereMessage('level.current', ['Level-up announcement'])).toBe(
      "{level.current} only works in the level-up announcement, so it's posted as written here.",
    );
    expect(elsewhereMessage('user.name', ['Welcome message', 'Goodbye message'])).toContain(
      'in the welcome message or the goodbye message',
    );
    expect(elsewhereMessage('x', [])).toBeUndefined();
  });
});
