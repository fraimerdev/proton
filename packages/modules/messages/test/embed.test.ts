import { describe, expect, test } from 'bun:test';
import {
  EMBED_AUTHOR_NAME_MAX,
  EMBED_COLOR_MAX,
  EMBED_DESCRIPTION_MAX,
  EMBED_FIELD_NAME_MAX,
  EMBED_FIELD_VALUE_MAX,
  EMBED_FIELDS_MAX,
  EMBED_FOOTER_MAX,
  EMBED_TITLE_MAX,
  EMBED_TOTAL_MAX,
  type EmbedContent,
} from '../src/config.ts';
import { buildEmbed, embedLength, parseEmbedColour, parseEmbedLink } from '../src/embed.ts';

const AT = new Date('2026-08-17T12:00:00.000Z');

function reason(content: EmbedContent, subject?: string): string {
  const result = buildEmbed(content, { ...(subject ? { subject } : {}) });
  if (result.ok) throw new Error('expected buildEmbed to refuse this spec');
  return result.humanReason;
}

function built(content: EmbedContent): Record<string, unknown> {
  const result = buildEmbed(content, { now: AT });
  if (!result.ok) throw new Error(`expected buildEmbed to accept this spec: ${result.humanReason}`);
  return result.embed as Record<string, unknown>;
}

describe('buildEmbed', () => {
  test('turns a full spec into exactly the object Discord expects', () => {
    expect(
      built({
        title: 'Server rules',
        description: 'Be kind.',
        url: 'https://example.test/rules',
        color: 0x5865f2,
        imageUrl: 'https://example.test/banner.png',
        thumbnailUrl: 'https://example.test/icon.png',
        footer: 'Updated monthly',
        authorName: 'The moderators',
        timestamp: true,
        fields: [
          { name: 'Rule 1', value: 'No spam', inline: true },
          { name: 'Rule 2', value: 'No invites' },
        ],
      }),
    ).toEqual({
      title: 'Server rules',
      description: 'Be kind.',
      url: 'https://example.test/rules',
      color: 0x5865f2,
      timestamp: AT.toISOString(),
      footer: { text: 'Updated monthly' },
      image: { url: 'https://example.test/banner.png' },
      thumbnail: { url: 'https://example.test/icon.png' },
      author: { name: 'The moderators' },
      fields: [
        { name: 'Rule 1', value: 'No spam', inline: true },
        { name: 'Rule 2', value: 'No invites' },
      ],
    });
  });

  test('drops every key the spec did not set rather than sending nulls', () => {
    expect(built({ description: 'Just this.' })).toEqual({ description: 'Just this.' });
  });

  test('a timestamp is only stamped when the spec asks for one', () => {
    expect(built({ description: 'x', timestamp: false })).not.toHaveProperty('timestamp');
    expect(built({ description: 'x' })).not.toHaveProperty('timestamp');
  });

  test('colour 0 survives, because black is a colour and not an absent one', () => {
    expect(built({ description: 'x', color: 0 })).toMatchObject({ color: 0 });
  });

  test('trims the text it sends and treats whitespace-only as absent', () => {
    expect(built({ title: '  Rules  ', description: '   ', footer: '\n\t' })).toEqual({
      title: 'Rules',
    });
  });

  test('an image alone is a postable embed', () => {
    expect(built({ imageUrl: 'https://example.test/a.png' })).toEqual({
      image: { url: 'https://example.test/a.png' },
    });
  });
});

describe('buildEmbed refuses an empty embed', () => {
  test('nothing at all is an error, not an empty post', () => {
    expect(reason({})).toContain('has nothing in it');
  });

  test('a colour, a url and a timestamp render nothing on their own', () => {
    expect(reason({ color: 0xff0000, url: 'https://example.test', timestamp: true })).toContain(
      'has nothing in it',
    );
  });

  test('an empty fields array is not content', () => {
    expect(reason({ fields: [] })).toContain('has nothing in it');
  });

  test('it says which embed, when it was told', () => {
    expect(reason({}, 'The saved embed “welcome”')).toContain('The saved embed “welcome”');
  });
});

describe('buildEmbed enforces every Discord cap', () => {
  test('title over 256', () => {
    const message = reason({ title: 'a'.repeat(EMBED_TITLE_MAX + 3) });
    expect(message).toContain('title');
    expect(message).toContain(String(EMBED_TITLE_MAX));
    expect(message).toContain('Remove 3');
  });

  test('title of exactly 256 is fine', () => {
    expect(built({ title: 'a'.repeat(EMBED_TITLE_MAX) }).title).toHaveLength(EMBED_TITLE_MAX);
  });

  test('description over 4096', () => {
    const message = reason({ description: 'a'.repeat(EMBED_DESCRIPTION_MAX + 1) });
    expect(message).toContain('description');
    expect(message).toContain(String(EMBED_DESCRIPTION_MAX));
  });

  test('footer over 2048', () => {
    const message = reason({ footer: 'a'.repeat(EMBED_FOOTER_MAX + 1) });
    expect(message).toContain('footer');
    expect(message).toContain(String(EMBED_FOOTER_MAX));
  });

  test('author name over 256', () => {
    const message = reason({ authorName: 'a'.repeat(EMBED_AUTHOR_NAME_MAX + 1) });
    expect(message).toContain('author name');
    expect(message).toContain(String(EMBED_AUTHOR_NAME_MAX));
  });

  test('more than 25 fields', () => {
    const fields = Array.from({ length: EMBED_FIELDS_MAX + 2 }, (_, index) => ({
      name: `n${index}`,
      value: 'v',
    }));

    const message = reason({ fields });
    expect(message).toContain(`${EMBED_FIELDS_MAX + 2} fields`);
    expect(message).toContain('Remove 2');
  });

  test('exactly 25 fields is fine', () => {
    const fields = Array.from({ length: EMBED_FIELDS_MAX }, (_, index) => ({
      name: `n${index}`,
      value: 'v',
    }));

    expect(built({ fields }).fields).toHaveLength(EMBED_FIELDS_MAX);
  });

  test('a field name over 256 names which field', () => {
    const message = reason({
      fields: [
        { name: 'ok', value: 'v' },
        { name: 'a'.repeat(EMBED_FIELD_NAME_MAX + 1), value: 'v' },
      ],
    });

    expect(message).toContain('field 2’s name');
    expect(message).toContain(String(EMBED_FIELD_NAME_MAX));
  });

  test('a field value over 1024 names which field', () => {
    const message = reason({
      fields: [{ name: 'n', value: 'a'.repeat(EMBED_FIELD_VALUE_MAX + 1) }],
    });

    expect(message).toContain('field 1’s text');
    expect(message).toContain(String(EMBED_FIELD_VALUE_MAX));
  });

  test('a nameless field is refused rather than sent', () => {
    expect(reason({ fields: [{ name: '   ', value: 'v' }] })).toContain('field 1 has no name');
  });

  test('a field with no text is refused rather than sent', () => {
    expect(reason({ fields: [{ name: 'n', value: '  ' }] })).toContain('field 1 has no text');
  });
});

describe('buildEmbed enforces the colour bounds', () => {
  test('accepts both ends of the range', () => {
    expect(built({ description: 'x', color: 0 }).color).toBe(0);
    expect(built({ description: 'x', color: EMBED_COLOR_MAX }).color).toBe(EMBED_COLOR_MAX);
  });

  test('refuses a negative colour', () => {
    expect(reason({ description: 'x', color: -1 })).toContain('not a colour Discord takes');
  });

  test('refuses a colour past #ffffff', () => {
    const message = reason({ description: 'x', color: EMBED_COLOR_MAX + 1 });
    expect(message).toContain(String(EMBED_COLOR_MAX));
  });

  test('refuses a fractional colour', () => {
    expect(reason({ description: 'x', color: 1.5 })).toContain('whole number');
  });
});

describe('the 6000-character total', () => {
  const overBudget: EmbedContent = {
    title: 'a'.repeat(EMBED_TITLE_MAX),
    description: 'b'.repeat(EMBED_DESCRIPTION_MAX),
    footer: 'c'.repeat(EMBED_FOOTER_MAX),
  };

  test('every part can be inside its own cap and the whole still be refused', () => {
    const message = reason(overBudget, 'The saved embed “welcome”');

    expect(message).toContain('The saved embed “welcome”');
    expect(message).toContain(String(EMBED_TOTAL_MAX));
    expect(message).toContain('6400 characters');
    expect(message).toContain('Remove 400');
  });

  test('exactly 6000 is accepted', () => {
    const content: EmbedContent = {
      title: 'a'.repeat(EMBED_TITLE_MAX),
      description: 'b'.repeat(EMBED_DESCRIPTION_MAX),
      footer: 'c'.repeat(EMBED_TOTAL_MAX - EMBED_TITLE_MAX - EMBED_DESCRIPTION_MAX),
    };

    expect(embedLength(content)).toBe(EMBED_TOTAL_MAX);
    expect(buildEmbed(content).ok).toBe(true);
  });

  test('field names and values both count toward it', () => {
    const content: EmbedContent = {
      description: 'd'.repeat(EMBED_DESCRIPTION_MAX),
      fields: Array.from({ length: 2 }, () => ({
        name: 'n'.repeat(EMBED_FIELD_NAME_MAX),
        value: 'v'.repeat(EMBED_FIELD_VALUE_MAX),
      })),
    };

    expect(embedLength(content)).toBe(EMBED_DESCRIPTION_MAX + 2 * 1280);
    expect(buildEmbed(content).ok).toBe(false);
  });
});

describe('embedLength', () => {
  test('counts title, description, fields, footer and author and nothing else', () => {
    expect(
      embedLength({
        title: '12345',
        description: '123',
        footer: '12',
        authorName: '1',
        url: 'https://example.test/a-very-long-link-that-must-not-count',
        imageUrl: 'https://example.test/also-not-counted.png',
        color: 0xffffff,
        timestamp: true,
        fields: [{ name: '12', value: '1234' }],
      }),
    ).toBe(5 + 3 + 2 + 1 + 2 + 4);
  });

  test('is zero for an empty spec', () => {
    expect(embedLength({})).toBe(0);
  });

  test('measures the trimmed text, which is what gets sent', () => {
    expect(embedLength({ title: '   ab   ' })).toBe(2);
  });
});

describe('parseEmbedColour', () => {
  test('blank means no colour at all', () => {
    expect(parseEmbedColour(undefined)).toEqual({ ok: true, color: null });
    expect(parseEmbedColour('   ')).toEqual({ ok: true, color: null });
  });

  test('reads a hex code with or without its prefix', () => {
    expect(parseEmbedColour('#5865F2')).toEqual({ ok: true, color: 0x5865f2 });
    expect(parseEmbedColour('5865f2')).toEqual({ ok: true, color: 0x5865f2 });
    expect(parseEmbedColour('0x5865F2')).toEqual({ ok: true, color: 0x5865f2 });
    expect(parseEmbedColour('  #ffffff ')).toEqual({ ok: true, color: EMBED_COLOR_MAX });
  });

  test('six digits are read as hex, because that is what a colour code is', () => {
    expect(parseEmbedColour('123456')).toEqual({ ok: true, color: 0x123456 });
  });

  test('reads a plain decimal that is not six digits long', () => {
    expect(parseEmbedColour('291')).toEqual({ ok: true, color: 291 });
    expect(parseEmbedColour('16777215')).toEqual({ ok: true, color: EMBED_COLOR_MAX });
  });

  test('refuses a decimal past #ffffff and names the ceiling', () => {
    const result = parseEmbedColour('16777216');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.humanReason).toContain(String(EMBED_COLOR_MAX));
  });

  test('refuses something that is not a colour and says what one looks like', () => {
    const result = parseEmbedColour('blurple');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.humanReason).toContain('#5865F2');
  });

  test('refuses a five-character hex rather than guessing', () => {
    expect(parseEmbedColour('#12345').ok).toBe(false);
  });
});

describe('parseEmbedLink', () => {
  test('blank means no link', () => {
    expect(parseEmbedLink('', 'the image slot')).toEqual({ ok: true, url: null });
    expect(parseEmbedLink(undefined, 'the image slot')).toEqual({ ok: true, url: null });
  });

  test('accepts http and https', () => {
    expect(parseEmbedLink('https://example.test/a.png', 'x')).toEqual({
      ok: true,
      url: 'https://example.test/a.png',
    });
    expect(parseEmbedLink(' http://example.test/a.png ', 'x')).toEqual({
      ok: true,
      url: 'http://example.test/a.png',
    });
  });

  test('refuses a bare domain and says what is missing', () => {
    const result = parseEmbedLink('example.test/a.png', 'an embed’s image slot');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.humanReason).toContain('http://');
    expect(result.ok === false && result.humanReason).toContain('image slot');
  });

  test('refuses a scheme Discord will not fetch', () => {
    expect(parseEmbedLink('javascript:alert(1)', 'x').ok).toBe(false);
    expect(parseEmbedLink('ftp://example.test/a.png', 'x').ok).toBe(false);
  });
});
