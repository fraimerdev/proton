import { describe, expect, test } from 'bun:test';
import {
  COMPONENT_KEY_MAX,
  DEFAULT_MENTION_POLICY,
  limitFor,
  MAX_AUTOCOMPLETE_CHOICES,
  MAX_CUSTOM_ID_LENGTH,
  zodToDescriptors,
} from '@proton/core';
import { describeList, describeUnknown } from '../src/commands.ts';
import {
  EMBED_DESCRIPTION_MAX,
  EMBED_FIELD_VALUE_MAX,
  EMBED_FIELDS_MAX,
  EMBED_TITLE_MAX,
  EMBED_TOTAL_MAX,
  encodedLength,
  findTemplate,
  MAX_TEMPLATES,
  messagesConfigSchema,
  messagesDefaultConfig,
  messagesFormSchema,
  normaliseTemplateName,
  renderNames,
  type SavedMessage,
  suggestTemplateNames,
  TEMPLATE_NAME_MAX,
  templateContentSchema,
  templatesSchema,
} from '../src/config.ts';

function named(...names: string[]): SavedMessage[] {
  return names.map((name) => ({
    name,
    embeds: [{ description: 'x' }],
    components: [],
    mentions: DEFAULT_MENTION_POLICY,
    v2: [],
  }));
}

describe('messagesConfigSchema', () => {
  test('the default config satisfies its own schema', () => {
    expect(messagesConfigSchema.parse(messagesDefaultConfig)).toEqual(messagesDefaultConfig);
  });

  test('is off with no templates until an admin says otherwise', () => {
    expect(messagesConfigSchema.parse({})).toEqual({
      enabled: false,
      templates: [],
      components: [],
    });
  });

  test('keeps a saved message whole', () => {
    const saved = {
      name: 'welcome',
      content: 'Heads up',
      embeds: [
        {
          title: 'Welcome',
          description: 'Read the rules.',
          color: 0x5865f2,
          fields: [{ name: 'Step 1', value: 'Say hello', inline: true }],
        },
      ],
      components: [],
      mentions: DEFAULT_MENTION_POLICY,
      v2: [],
    };

    expect(messagesConfigSchema.parse({ enabled: true, templates: [saved] }).templates[0]).toEqual(
      saved,
    );
  });

  test('fills in the parts a message did not name rather than dropping the row', () => {
    const parsed = messagesConfigSchema.parse({
      templates: [{ name: 'rules', embeds: [{ description: 'Be kind.' }] }],
    });

    expect(parsed.templates[0]?.components).toEqual([]);
    expect(parsed.templates[0]?.mentions).toEqual(DEFAULT_MENTION_POLICY);
  });
});

describe('a v1 row survives being read back', () => {
  const V1_ROW = {
    name: 'welcome',
    title: 'Welcome',
    description: 'Read the rules.',
    footer: 'Updated monthly',
    authorName: 'The moderators',
    timestamp: true,
    fields: [{ name: 'Step 1', value: 'Say hello', inline: true }],
  };

  test('every flat key is lifted into the one embed it was', () => {
    const parsed = messagesConfigSchema.parse({ enabled: true, templates: [V1_ROW] });

    expect(parsed.templates[0]?.name).toBe('welcome');
    expect(parsed.templates[0]?.embeds).toEqual([
      {
        title: 'Welcome',
        description: 'Read the rules.',
        footer: { text: 'Updated monthly' },
        author: { name: 'The moderators' },
        timestamp: 'now',
        fields: [{ name: 'Step 1', value: 'Say hello', inline: true }],
      },
    ]);
  });

  // The on/off switch writes back the re-parsed config: a lift that is not idempotent empties it.
  test('re-parsing what a parse returned changes nothing and empties nothing', () => {
    const once = messagesConfigSchema.parse({ enabled: true, templates: [V1_ROW] });
    const twice = messagesConfigSchema.parse({ ...once, enabled: false });

    expect(twice.templates).toEqual(once.templates);
    expect(twice.templates[0]?.embeds).toHaveLength(1);
    expect(twice.templates[0]?.embeds[0]?.description).toBe('Read the rules.');
    expect(messagesConfigSchema.parse(twice).templates).toEqual(once.templates);
  });

  test('a v1 row with only a description still parses instead of being refused as empty', () => {
    const parsed = messagesConfigSchema.parse({
      templates: [{ name: 'rules', description: 'Be kind.' }],
    });

    expect(parsed.templates[0]?.embeds).toEqual([{ description: 'Be kind.' }]);
  });

  test('timestamp: false lifts to no timestamp at all', () => {
    const parsed = messagesConfigSchema.parse({
      templates: [{ name: 'rules', description: 'Be kind.', timestamp: false }],
    });

    expect(parsed.templates[0]?.embeds[0]).not.toHaveProperty('timestamp');
  });
});

describe('the saved-embed schema enforces Discord’s caps', () => {
  const base = { name: 'welcome' };

  test('a name is required and capped', () => {
    expect(templateContentSchema.safeParse({ description: 'x' }).success).toBe(false);
    expect(templateContentSchema.safeParse({ name: '   ', description: 'x' }).success).toBe(false);
    expect(
      templateContentSchema.safeParse({ name: 'a'.repeat(TEMPLATE_NAME_MAX + 1), description: 'x' })
        .success,
    ).toBe(false);
    expect(
      templateContentSchema.safeParse({ name: 'a'.repeat(TEMPLATE_NAME_MAX), description: 'x' })
        .success,
    ).toBe(true);
  });

  test('title, description, footer and author name', () => {
    expect(templateContentSchema.safeParse({ ...base, title: 'a'.repeat(257) }).success).toBe(
      false,
    );
    expect(
      templateContentSchema.safeParse({ ...base, title: 'a'.repeat(EMBED_TITLE_MAX) }).success,
    ).toBe(true);
    expect(
      templateContentSchema.safeParse({ ...base, description: 'a'.repeat(4097) }).success,
    ).toBe(false);
    expect(
      templateContentSchema.safeParse({ ...base, description: 'a'.repeat(EMBED_DESCRIPTION_MAX) })
        .success,
    ).toBe(true);
    expect(templateContentSchema.safeParse({ ...base, footer: 'a'.repeat(2049) }).success).toBe(
      false,
    );
    expect(templateContentSchema.safeParse({ ...base, authorName: 'a'.repeat(257) }).success).toBe(
      false,
    );
  });

  test('field names, field text and the field count', () => {
    expect(
      templateContentSchema.safeParse({ ...base, fields: [{ name: 'a'.repeat(257), value: 'v' }] })
        .success,
    ).toBe(false);
    expect(
      templateContentSchema.safeParse({
        ...base,
        fields: [{ name: 'n', value: 'a'.repeat(EMBED_FIELD_VALUE_MAX + 1) }],
      }).success,
    ).toBe(false);

    const fields = Array.from({ length: EMBED_FIELDS_MAX + 1 }, () => ({ name: 'n', value: 'v' }));
    expect(templateContentSchema.safeParse({ ...base, fields }).success).toBe(false);
    expect(templateContentSchema.safeParse({ ...base, fields: fields.slice(1) }).success).toBe(
      true,
    );
  });

  test('a colour outside 0..0xffffff', () => {
    expect(templateContentSchema.safeParse({ ...base, color: -1 }).success).toBe(false);
    expect(templateContentSchema.safeParse({ ...base, color: 0x1000000 }).success).toBe(false);
    expect(templateContentSchema.safeParse({ ...base, color: 1.5 }).success).toBe(false);
    expect(templateContentSchema.safeParse({ ...base, color: 0xffffff }).success).toBe(true);
  });

  test('links have to be links Discord can fetch', () => {
    expect(
      templateContentSchema.safeParse({ ...base, imageUrl: 'example.test/a.png' }).success,
    ).toBe(false);
    expect(
      templateContentSchema.safeParse({ ...base, thumbnailUrl: 'javascript:alert(1)' }).success,
    ).toBe(false);
    expect(
      templateContentSchema.safeParse({ ...base, url: 'https://example.test/rules' }).success,
    ).toBe(true);
  });
});

describe('the saved list', () => {
  test('is capped at the pro ceiling', () => {
    expect(MAX_TEMPLATES).toBe(limitFor('pro', 'savedTemplates'));

    const at = named(...Array.from({ length: MAX_TEMPLATES }, (_, index) => `e${index}`));

    expect(templatesSchema.safeParse(at).success).toBe(true);
    expect(templatesSchema.safeParse([...at, ...named('one-more')]).success).toBe(false);
  });

  test('refuses two embeds with the same name, whatever the casing', () => {
    const result = templatesSchema.safeParse(named('Welcome', 'welcome'));

    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues[0]?.message).toContain(
      'which of them you meant',
    );
  });
});

describe('the 6000-character cap counts every embed on the message', () => {
  function spread(each: number, count: number): unknown {
    return {
      name: 'huge',
      embeds: Array.from({ length: count }, (_, index) => ({
        description: String.fromCharCode(97 + index).repeat(each),
      })),
    };
  }

  test('embeds that are each inside their own cap can still be over the total', () => {
    const result = templatesSchema.safeParse([spread(EMBED_DESCRIPTION_MAX, 2)]);
    const over = 2 * EMBED_DESCRIPTION_MAX - EMBED_TOTAL_MAX;

    expect(result.success).toBe(false);

    const message = (result.success === false && result.error.issues[0]?.message) || '';
    expect(message).toContain(String(2 * EMBED_DESCRIPTION_MAX));
    expect(message).toContain(String(EMBED_TOTAL_MAX));
    expect(message).toContain(`Remove ${over}`);
  });

  test('exactly 6000 spread over three embeds is accepted', () => {
    expect(templatesSchema.safeParse([spread(EMBED_TOTAL_MAX / 3, 3)]).success).toBe(true);
  });
});

describe('a component key has to fit in a custom_id', () => {
  const LONG_KEY = 'a'.repeat(COMPONENT_KEY_MAX);

  // Colons, not padding: escaping doubles them, and a plain 32-char name and key fit in 79.
  const LONG_NAME = `welcome${':'.repeat(TEMPLATE_NAME_MAX - 'welcome'.length)}`;

  function withButton(name: string, key: string): unknown {
    return {
      name,
      embeds: [{ description: 'Pick one.' }],
      components: [
        {
          kind: 'buttons',
          buttons: [
            {
              key,
              style: 'primary',
              label: 'Press me',
              action: { kind: 'reply', content: 'Hello.' },
            },
          ],
        },
      ],
    };
  }

  test('encodedLength counts the prefix and the escaping', () => {
    expect(encodedLength('welcome', 'rules')).toBe('proton:messages:welcome:rules'.length);
    expect(encodedLength(LONG_NAME, LONG_KEY)).toBeGreaterThan(MAX_CUSTOM_ID_LENGTH);
  });

  test('a name and key that will not fit are refused, and it says to shorten which', () => {
    const result = templatesSchema.safeParse([withButton(LONG_NAME, LONG_KEY)]);

    expect(result.success).toBe(false);

    const message = (result.success === false && result.error.issues[0]?.message) || '';
    expect(message).toContain(String(encodedLength(LONG_NAME, LONG_KEY)));
    expect(message).toContain(String(MAX_CUSTOM_ID_LENGTH));
    expect(message).toContain('Shorten the message name or the key');
  });

  test('the longest plain name and key still fit, so the guard is not over-eager', () => {
    expect(
      templatesSchema.safeParse([withButton('a'.repeat(TEMPLATE_NAME_MAX), LONG_KEY)]).success,
    ).toBe(true);
  });

  test('a link button carries no custom_id, so its key is never measured', () => {
    const linked = {
      name: LONG_NAME,
      embeds: [{ description: 'Where to go.' }],
      components: [
        {
          kind: 'buttons',
          buttons: [
            { key: LONG_KEY, style: 'link', label: 'Website', url: 'https://example.test/' },
          ],
        },
      ],
    };

    expect(templatesSchema.safeParse([linked]).success).toBe(true);
  });
});

describe('messagesFormSchema', () => {
  test('omits the saved embeds, which the v1 form generator cannot render', () => {
    expect(Object.keys(messagesFormSchema.shape)).toEqual(['enabled']);
  });

  test('the generator refuses the full config and accepts the form schema', () => {
    expect(() => zodToDescriptors(messagesConfigSchema)).toThrow();
    expect(zodToDescriptors(messagesFormSchema).map((field) => field.path)).toEqual(['enabled']);
  });
});

describe('findTemplate', () => {
  test('finds a saved embed however the member typed its name', () => {
    const saved = named('Server Rules');

    expect(findTemplate(saved, '  server rules ')?.name).toBe('Server Rules');
    expect(findTemplate(saved, 'SERVER RULES')?.name).toBe('Server Rules');
  });

  test('returns nothing rather than the first row when there is no match', () => {
    expect(findTemplate(named('rules', 'faq'), 'welcome')).toBeUndefined();
  });

  test('normaliseTemplateName is what both sides agree on', () => {
    expect(normaliseTemplateName('  Rules  ')).toBe('rules');
  });
});

describe('suggestTemplateNames', () => {
  test('matches anywhere in the name, not just the start', () => {
    expect(suggestTemplateNames(named('server-rules', 'faq'), 'rules', 25)).toEqual([
      'server-rules',
    ]);
  });

  test('puts what the member is prefixing first', () => {
    expect(suggestTemplateNames(named('server-rules', 'rules', 'rulebook'), 'rule', 25)).toEqual([
      'rulebook',
      'rules',
      'server-rules',
    ]);
  });

  test('an empty prefix offers everything, alphabetically', () => {
    expect(suggestTemplateNames(named('b', 'a', 'c'), '', 25)).toEqual(['a', 'b', 'c']);
  });

  test('never offers more than Discord will show', () => {
    const saved = named(...Array.from({ length: 40 }, (_, index) => `e${index}`));

    expect(suggestTemplateNames(saved, '', MAX_AUTOCOMPLETE_CHOICES)).toHaveLength(
      MAX_AUTOCOMPLETE_CHOICES,
    );
  });

  test('is case-insensitive on both sides', () => {
    expect(suggestTemplateNames(named('Welcome'), 'WEL', 25)).toEqual(['Welcome']);
  });
});

describe('renderNames', () => {
  test('lists names in code ticks', () => {
    expect(renderNames(['a', 'b'])).toBe('`a`, `b`');
  });

  test('says how many it did not list', () => {
    expect(renderNames(['a', 'b', 'c'], 2)).toBe('`a`, `b` and 1 more');
  });
});

describe('what the member is told', () => {
  test('an unknown name lists the names that do exist', () => {
    const message = describeUnknown(named('rules', 'faq'), 'welcome');

    expect(message).toContain('welcome');
    expect(message).toContain('`rules`');
    expect(message).toContain('`faq`');
  });

  test('an unknown name in an empty server points at the dashboard and /message send', () => {
    const message = describeUnknown([], 'welcome');

    expect(message).toContain('dashboard');
    expect(message).toContain('/message send');
  });

  test('the list names them and counts them', () => {
    expect(describeList(named('rules', 'faq'))).toContain('2 in this server');
  });

  test('an empty list says where embeds come from', () => {
    expect(describeList([])).toContain('dashboard');
  });
});
