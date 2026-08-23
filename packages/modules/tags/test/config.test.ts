import { describe, expect, test } from 'bun:test';
import { normalisePrefix } from '../src/autocomplete.ts';
import { renderList } from '../src/commands.ts';
import { normaliseTagName, TAG_NAME_MAX, tagsConfigSchema } from '../src/config.ts';

describe('normaliseTagName', () => {
  test('lowercases, trims and turns runs of whitespace into a single dash', () => {
    expect(normaliseTagName('  Server   Rules  ')).toEqual({ ok: true, name: 'server-rules' });
  });

  test('accepts dots, dashes, digits and underscores', () => {
    expect(normaliseTagName('faq.v2_final-1')).toEqual({ ok: true, name: 'faq.v2_final-1' });
  });

  test('refuses an empty name and says so', () => {
    const result = normaliseTagName('   ');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.humanReason).toContain('empty');
  });

  test('refuses a name over the cap and names the cap', () => {
    const result = normaliseTagName('a'.repeat(TAG_NAME_MAX + 1));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.humanReason).toContain(String(TAG_NAME_MAX));
  });

  test('refuses a name that does not start with a letter or digit', () => {
    expect(normaliseTagName('-leading').ok).toBe(false);
    expect(normaliseTagName('.leading').ok).toBe(false);
  });

  test('refuses characters Discord members would not be able to retype', () => {
    expect(normaliseTagName('hey!').ok).toBe(false);
    expect(normaliseTagName('emoji😀').ok).toBe(false);
  });

  test('a normalised name normalises to itself', () => {
    const first = normaliseTagName('Some Tag');
    expect(first.ok).toBe(true);

    if (first.ok) expect(normaliseTagName(first.name)).toEqual(first);
  });
});

describe('normalisePrefix', () => {
  test('matches what normaliseTagName would have stored', () => {
    expect(normalisePrefix('  Server Ru')).toBe('server-ru');
  });

  test('never exceeds the name cap, so a pasted essay still queries', () => {
    expect(normalisePrefix('x'.repeat(500))).toHaveLength(TAG_NAME_MAX);
  });
});

describe('renderList', () => {
  test('says the server has none rather than showing an empty page', () => {
    expect(renderList([], 1, 0, 25)).toContain('no tags yet');
  });

  test('reports the page and the total', () => {
    const text = renderList(['a', 'b'], 2, 60, 25);

    expect(text).toContain('page 2 of 3');
    expect(text).toContain('60 in total');
  });

  test('explains an overshot page instead of looking empty', () => {
    expect(renderList([], 9, 3, 25)).toContain('Page 9 is empty');
  });
});

describe('tagsConfigSchema', () => {
  test('defaults leave the module off and tag text unable to ping', () => {
    const parsed = tagsConfigSchema.parse({});

    expect(parsed).toEqual({ enabled: false, ephemeral: false, allowMentions: false });
  });
});
