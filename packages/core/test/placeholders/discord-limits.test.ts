import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { MESSAGE_CONTENT_MAX } from '../../src/interactions/respond.ts';
import {
  BUTTON_LABEL_MAX,
  BUTTON_URL_MAX,
  SELECT_OPTION_DESCRIPTION_MAX,
  SELECT_OPTION_LABEL_MAX,
  SELECT_PLACEHOLDER_MAX,
} from '../../src/messages/components.ts';
import {
  EMBED_AUTHOR_NAME_MAX,
  EMBED_DESCRIPTION_MAX,
  EMBED_FIELD_NAME_MAX,
  EMBED_FIELD_VALUE_MAX,
  EMBED_FOOTER_TEXT_MAX,
  EMBED_TITLE_MAX,
  EMBED_TOTAL_MAX,
} from '../../src/messages/embed.ts';
import type { ProtonMessage } from '../../src/messages/message.ts';
import { MEDIA_DESCRIPTION_MAX } from '../../src/messages/v2.ts';
import {
  CHANNEL_NAME_MAX,
  clipGraphemes,
  DISCORD_TEXT_LIMITS,
  enforceMessageLimits,
  type LimitCode,
} from '../../src/placeholders/index.ts';

const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}';
const MENTION = '<@100000000000000010>';
const UNCLOSED = /<(?:@[!&]?|#|t:)[^>]*$/;
const LONE_HIGH = /[\uD800-\uDBFF]$/;

function message(parts: Partial<ProtonMessage> = {}): ProtonMessage {
  return {
    embeds: [],
    components: [],
    mentions: { everyone: false, roles: true, users: true },
    v2: [],
    ...parts,
  };
}

interface Report {
  path: string;
  message: string;
  code: LimitCode;
}

function limited(input: ProtonMessage): { output: ProtonMessage; reports: Report[] } {
  const reports: Report[] = [];
  const output = enforceMessageLimits(input, (path, text, code = 'output_truncated') => {
    reports.push({ path, message: text, code });
  });
  return { output, reports };
}

function graphemeEnds(text: string): Set<number> {
  const ends = new Set([0]);
  let end = 0;
  for (const { segment } of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)) {
    end += segment.length;
    ends.add(end);
  }
  return ends;
}

describe('clipGraphemes', () => {
  test('text within the limit comes back unchanged', () => {
    expect(clipGraphemes('hello', 5)).toBe('hello');
    expect(clipGraphemes('hello', 10)).toBe('hello');
    expect(clipGraphemes('', 0)).toBe('');
  });

  test('counts UTF-16 code units, which is what Discord counts', () => {
    expect(clipGraphemes('abcdef', 3)).toBe('abc');
    expect(clipGraphemes('\u{1F600}\u{1F600}', 3)).toBe('\u{1F600}');
    expect(FAMILY).toHaveLength(8);
  });

  test('cuts only on a grapheme boundary', () => {
    const families = FAMILY.repeat(200);

    expect(clipGraphemes(families, 256)).toBe(FAMILY.repeat(32));
    expect(clipGraphemes(families, 255)).toBe(FAMILY.repeat(31));
    expect(clipGraphemes('é'.repeat(10), 5)).toBe('é'.repeat(2));
  });

  test('never leaves half a mention or timestamp', () => {
    for (const markup of [
      MENTION,
      '<@!100000000000000010>',
      '<@&100000000000000020>',
      '<#100000000000000040>',
      '<t:1789376400:f>',
    ]) {
      const text = `hi ${markup} there`;
      expect(clipGraphemes(text, 10)).toBe('hi ');
      expect(clipGraphemes(text, 3 + markup.length)).toBe(`hi ${markup}`);
    }

    expect(clipGraphemes('a < b and more', 5)).toBe('a < b');
  });

  test('a limit that is not a length is read safely', () => {
    expect(clipGraphemes('hello', 0)).toBe('');
    expect(clipGraphemes('hello', -3)).toBe('');
    expect(clipGraphemes('hello', 2.9)).toBe('he');
    expect(clipGraphemes('hello', Number.NaN)).toBe('hello');
    expect(clipGraphemes('hello', Number.POSITIVE_INFINITY)).toBe('hello');
  });

  test('without Intl.Segmenter it still never splits a surrogate pair', () => {
    const original = Intl.Segmenter;
    Object.defineProperty(Intl, 'Segmenter', {
      value: undefined,
      configurable: true,
      writable: true,
    });

    try {
      expect(clipGraphemes(FAMILY.repeat(10), 13)).toBe(`${FAMILY}\u{1F468}‍\u{1F469}`);
      expect(clipGraphemes(FAMILY.repeat(10), 12)).toBe(`${FAMILY}\u{1F468}‍`);
    } finally {
      Object.defineProperty(Intl, 'Segmenter', {
        value: original,
        configurable: true,
        writable: true,
      });
    }

    expect(clipGraphemes(FAMILY.repeat(10), 13)).toBe(FAMILY);
  });

  test('never passes the limit, splits a grapheme or leaves markup open', () => {
    const piece = fc.constantFrom(
      'a',
      ' ',
      'é',
      'é',
      '\u{1F600}',
      FAMILY,
      '\u{1F1EF}\u{1F1F5}',
      MENTION,
      '<@&100000000000000020>',
      '<#100000000000000040>',
      '<t:1789376400:R>',
      '<',
      '>',
    );

    fc.assert(
      fc.property(
        fc.array(piece, { maxLength: 80 }),
        fc.integer({ min: 0, max: 400 }),
        (pieces, max) => {
          const text = pieces.join('');
          const clipped = clipGraphemes(text, max);

          if (text.length <= max) return clipped === text;

          return (
            clipped.length <= max &&
            text.startsWith(clipped) &&
            graphemeEnds(text).has(clipped.length) &&
            !LONE_HIGH.test(clipped) &&
            !UNCLOSED.test(clipped)
          );
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('DISCORD_TEXT_LIMITS', () => {
  test('agrees with the limits the stored message shapes already enforce', () => {
    expect(DISCORD_TEXT_LIMITS).toMatchObject({
      content: MESSAGE_CONTENT_MAX,
      embedTitle: EMBED_TITLE_MAX,
      embedDescription: EMBED_DESCRIPTION_MAX,
      embedFieldName: EMBED_FIELD_NAME_MAX,
      embedFieldValue: EMBED_FIELD_VALUE_MAX,
      embedFooter: EMBED_FOOTER_TEXT_MAX,
      embedAuthor: EMBED_AUTHOR_NAME_MAX,
      embedTotal: EMBED_TOTAL_MAX,
      buttonLabel: BUTTON_LABEL_MAX,
      buttonUrl: BUTTON_URL_MAX,
      selectPlaceholder: SELECT_PLACEHOLDER_MAX,
      selectOptionLabel: SELECT_OPTION_LABEL_MAX,
      selectOptionDescription: SELECT_OPTION_DESCRIPTION_MAX,
      mediaDescription: MEDIA_DESCRIPTION_MAX,
      channelName: CHANNEL_NAME_MAX,
    });
    expect(DISCORD_TEXT_LIMITS.textDisplay).toBe(4000);
  });
});

describe('enforceMessageLimits', () => {
  test('a message within every limit is untouched and nothing is reported', () => {
    const input = message({
      content: 'hi',
      embeds: [{ title: 't', description: 'd', footer: { text: 'f' } }],
    });
    const { output, reports } = limited(input);

    expect(output).toEqual(input);
    expect(reports).toEqual([]);
  });

  test('clips every text field to its own limit and reports each path', () => {
    const { output, reports } = limited(
      message({
        content: 'x'.repeat(2500),
        embeds: [
          {
            title: 't'.repeat(300),
            author: { name: 'a'.repeat(300) },
            footer: { text: 'f'.repeat(2100) },
            fields: [{ name: 'n'.repeat(300), value: 'v'.repeat(1100) }],
          },
        ],
      }),
    );

    const [embed] = output.embeds;
    expect(output.content).toHaveLength(2000);
    expect(embed?.title).toHaveLength(256);
    expect(embed?.author?.name).toHaveLength(256);
    expect(embed?.footer?.text).toHaveLength(2048);
    expect(embed?.fields?.[0]?.name).toHaveLength(256);
    expect(embed?.fields?.[0]?.value).toHaveLength(1024);
    expect(reports.map(({ path }) => path)).toEqual([
      'content',
      'embeds.0.title',
      'embeds.0.author.name',
      'embeds.0.footer.text',
      'embeds.0.fields.0.name',
      'embeds.0.fields.0.value',
    ]);
    expect(reports.every(({ code }) => code === 'output_truncated')).toBe(true);
  });

  test('past 6000 across embeds, the last description is shortened first', () => {
    const { output, reports } = limited(
      message({ embeds: [{ description: 'a'.repeat(4000) }, { description: 'b'.repeat(4000) }] }),
    );

    expect(output.embeds.map((embed) => embed.description?.length)).toEqual([4000, 2000]);
    expect(reports.map(({ path }) => path)).toEqual(['embeds.1.description']);
  });

  test('then field values from the last field back', () => {
    const fields = Array.from({ length: 7 }, () => ({ name: 'n', value: 'v'.repeat(1000) }));
    const { output, reports } = limited(
      message({ embeds: [{ fields, footer: { text: 'f'.repeat(100) } }] }),
    );

    const [embed] = output.embeds;
    expect(embed?.fields?.map(({ value }) => value.length)).toEqual([
      1000, 1000, 1000, 1000, 1000, 892, 1,
    ]);
    expect(embed?.footer?.text).toHaveLength(100);
    expect(reports.map(({ path }) => path)).toEqual([
      'embeds.0.fields.6.value',
      'embeds.0.fields.5.value',
    ]);
  });

  test('then footers, from the last embed back', () => {
    const embed = () => ({
      title: 't'.repeat(256),
      author: { name: 'a'.repeat(256) },
      footer: { text: 'f'.repeat(2048) },
    });
    const { output, reports } = limited(message({ embeds: [embed(), embed(), embed()] }));

    expect(output.embeds.map((each) => each.footer?.text.length)).toEqual([2048, 2048, 368]);
    expect(reports.map(({ path }) => path)).toEqual(['embeds.2.footer.text']);
  });

  test('a link past its limit is emptied, never cut into a different address', () => {
    const { output, reports } = limited(
      message({
        embeds: [{ title: 't', url: `https://x.co/${'a'.repeat(2100)}` }],
        components: [
          {
            kind: 'buttons',
            buttons: [
              { key: 'go', style: 'link', label: 'Go', url: `https://x.co/${'a'.repeat(600)}` },
            ],
          },
        ],
      }),
    );

    expect(output.embeds[0]?.url).toBeUndefined();
    const [row] = output.components;
    expect(row?.kind === 'buttons' ? row.buttons[0]?.url : undefined).toBe('');
    expect(reports.map(({ path, code }) => [path, code])).toEqual([
      ['embeds.0.url', 'invalid_url'],
      ['components.0.buttons.0.url', 'invalid_url'],
    ]);
  });

  test('clips dropdown text and components-v2 text', () => {
    const { output, reports } = limited(
      message({
        components: [
          {
            kind: 'select',
            select: {
              key: 'pick',
              placeholder: 'p'.repeat(200),
              options: [
                {
                  key: 'a',
                  label: 'l'.repeat(120),
                  description: 'd'.repeat(150),
                  action: { kind: 'role', mode: 'add', roleId: '100000000000000020' },
                },
              ],
            },
          },
        ],
        v2: [
          { kind: 'text', content: 'x'.repeat(5000) },
          {
            kind: 'container',
            children: [
              {
                kind: 'section',
                text: ['y'.repeat(4100)],
                accessory: {
                  kind: 'button',
                  button: {
                    key: 'b',
                    style: 'primary',
                    label: 'b'.repeat(90),
                    action: { kind: 'role', mode: 'add', roleId: '100000000000000020' },
                  },
                },
              },
              {
                kind: 'gallery',
                items: [{ url: 'https://x.co/a.png', description: 'g'.repeat(1100) }],
              },
            ],
          },
        ],
      }),
    );

    expect(reports.map(({ path }) => path)).toEqual([
      'components.0.select.placeholder',
      'components.0.select.options.0.label',
      'components.0.select.options.0.description',
      'v2.0.content',
      'v2.1.children.0.text.0',
      'v2.1.children.0.accessory.button.label',
      'v2.1.children.1.items.0.description',
    ]);

    const [text, container] = output.v2;
    expect(text?.kind === 'text' ? text.content.length : 0).toBe(4000);
    const [section, gallery] = container?.kind === 'container' ? container.children : [];
    expect(section?.kind === 'section' ? section.text[0]?.length : 0).toBe(4000);
    expect(gallery?.kind === 'gallery' ? gallery.items[0]?.description?.length : 0).toBe(1024);
  });

  test('leaves the message it was given unchanged', () => {
    const input = message({ content: 'x'.repeat(2500), embeds: [{ title: 't'.repeat(300) }] });
    const before = structuredClone(input);

    limited(input);

    expect(input).toEqual(before);
  });
});
