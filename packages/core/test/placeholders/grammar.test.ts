import { describe, expect, test } from 'bun:test';
import {
  BRACE_ESCAPE_HELP,
  PLACEHOLDER_LIMITS,
  parseTemplate,
  placeholderValue as v,
  validateTemplate,
} from '../../src/placeholders/index.ts';
import { codes, registry, render } from './harness.ts';

describe('parseTemplate', () => {
  test('splits text and placeholders with spans, the raw text and the canonical key', () => {
    const parsed = parseTemplate('Hi {user}!', registry);

    expect(parsed.tokens).toEqual([
      { kind: 'text', text: 'Hi ', span: { start: 0, end: 3 } },
      {
        kind: 'placeholder',
        raw: '{user}',
        key: 'user',
        canonical: 'member.mention',
        modifiers: [],
        span: { start: 3, end: 9 },
      },
      { kind: 'text', text: '!', span: { start: 9, end: 10 } },
    ]);
    expect(parsed.diagnostics).toEqual([]);
  });

  test('leaves the canonical key empty when there is no registry to resolve it against', () => {
    expect(parseTemplate('{user}').tokens[0]).toMatchObject({ key: 'user', canonical: null });
  });

  test('a dynamic key is its own canonical key', () => {
    expect(parseTemplate('{answer.reason}', registry).tokens[0]).toMatchObject({
      canonical: 'answer.reason',
    });
  });

  test('parses a modifier chain of numbers and quoted text with its escapes', () => {
    const source = '{member.display_name:truncate(12):fallback("say \\"hi\\" \\\\ {x}")}';
    const [token] = parseTemplate(source).tokens;

    expect(token).toMatchObject({
      kind: 'placeholder',
      raw: source,
      key: 'member.display_name',
      modifiers: [
        { name: 'truncate', args: [12] },
        { name: 'fallback', args: ['say "hi" \\ {x}'] },
      ],
    });

    const span = token?.kind === 'placeholder' ? token.modifiers[0]?.span : undefined;
    expect(span && source.slice(span.start, span.end)).toBe(':truncate(12)');
  });

  test('reads negative and decimal numbers', () => {
    expect(parseTemplate('{a:truncate(-3):limit(2.5)}').tokens[0]).toMatchObject({
      modifiers: [
        { name: 'truncate', args: [-3] },
        { name: 'limit', args: [2.5] },
      ],
    });
  });
});

describe('literal braces', () => {
  test('{{ and }} render as { and }', () => {
    const parsed = parseTemplate('a {{b}} c }}{{');

    expect(parsed.tokens).toEqual([
      { kind: 'text', text: 'a {b} c }{', span: { start: 0, end: 14 } },
    ]);
    expect(parsed.diagnostics).toEqual([]);
  });

  test('an escaped placeholder is text, not a placeholder', () => {
    expect(render('{{user}}', { 'member.mention': v.user('123456789012345678') }).output).toBe(
      '{user}',
    );
  });

  test('a lone brace stays as written and is reported with how to write one', () => {
    const parsed = parseTemplate('a { b } c');

    expect(parsed.tokens).toEqual([
      { kind: 'text', text: 'a { b } c', span: { start: 0, end: 9 } },
    ]);
    expect(codes(parsed)).toEqual(['lone_brace', 'lone_brace']);
    expect(parsed.diagnostics.map((diagnostic) => diagnostic.span)).toEqual([
      { start: 2, end: 3 },
      { start: 6, end: 7 },
    ]);
    expect(parsed.diagnostics[0]?.message).toContain(BRACE_ESCAPE_HELP);
    expect(parsed.diagnostics[0]?.severity).toBe('warning');
  });

  test('empty braces are two lone braces', () => {
    expect(codes(parseTemplate('{}'))).toEqual(['lone_brace', 'lone_brace']);
  });

  test('whitespace inside braces is not a placeholder, and the message says so', () => {
    for (const source of ['{user }', '{ user}']) {
      const parsed = parseTemplate(source, registry);

      expect(parsed.tokens.every((token) => token.kind === 'text')).toBe(true);
      expect(parsed.diagnostics[0]?.message).toContain('cannot contain spaces');
      expect(render(source, { 'member.mention': v.user('123456789012345678') }).output).toBe(
        source,
      );
    }
  });
});

describe('malformed placeholders', () => {
  const cases = [
    '{user:}',
    '{user:upper',
    '{user:truncate(}',
    '{user:truncate()}',
    '{user:truncate(5 )}',
    '{user:truncate(abc)}',
    '{user:fallback("x}',
    '{user:fallback("a\\nb")}',
    '{user:Upper}',
  ];

  for (const source of cases) {
    test(`${source} is reported once and posted exactly as written`, () => {
      const rendered = render(source, { 'member.mention': v.user('123456789012345678') });

      expect(codes(parseTemplate(source))).toEqual(['malformed_placeholder']);
      expect(rendered.output).toBe(source);
    });
  }

  test('a rejected placeholder does not hide a later lone brace or placeholder', () => {
    expect(codes(parseTemplate('{user:Upper} and }'))).toEqual([
      'malformed_placeholder',
      'lone_brace',
    ]);
    expect(codes(parseTemplate('{user:Upper}} and }'))).toEqual([
      'malformed_placeholder',
      'lone_brace',
    ]);

    const rendered = render('{user:upper {server}', { 'server.name': v.text('P') });
    expect(rendered.output).toBe('{user:upper P');
    expect(codes(rendered)).toEqual(['malformed_placeholder']);
  });
});

describe('limits', () => {
  test('a template over the length limit is not filled in, and says so', () => {
    const source = `${'x'.repeat(PLACEHOLDER_LIMITS.templateLength)}{server}`;
    const parsed = parseTemplate(source, registry);

    expect(codes(parsed)).toEqual(['template_too_long']);
    expect(parsed.tokens).toHaveLength(1);
    expect(render(source, { 'server.name': v.text('P') }).output).toBe('x'.repeat(6000));
  });

  test('a template exactly at the limit is parsed', () => {
    const source = `${'x'.repeat(PLACEHOLDER_LIMITS.templateLength - 8)}{server}`;

    expect(codes(parseTemplate(source, registry))).toEqual([]);
  });

  test('placeholders past the count limit are posted as written, reported once', () => {
    const rendered = render('{server}'.repeat(PLACEHOLDER_LIMITS.placeholders + 2), {
      'server.name': v.text('P'),
    });

    expect(rendered.output).toBe(`${'P'.repeat(100)}{server}{server}`);
    expect(codes(rendered)).toEqual(['too_many_placeholders']);
  });

  test('a modifier chain is bounded', () => {
    const four = '{member.display_name:upper:lower:upper:lower}';
    const five = '{member.display_name:upper:lower:upper:lower:upper}';

    expect(codes(parseTemplate(four))).toEqual([]);
    expect(codes(parseTemplate(five))).toContain('too_many_modifiers');
    expect(render(five, { 'member.display_name': v.text('Ada') }).output).toBe(five);
  });

  test('arguments are bounded in number', () => {
    expect(codes(parseTemplate('{a:label("a","b","c","d")}'))).toEqual([]);
    expect(codes(parseTemplate('{a:label("a","b","c","d","e")}'))).toContain('too_many_arguments');
  });

  test('arguments are bounded in length', () => {
    const max = PLACEHOLDER_LIMITS.argumentLength;

    expect(codes(parseTemplate(`{a:fallback("${'x'.repeat(max)}")}`))).toEqual([]);
    expect(codes(parseTemplate(`{a:fallback("${'x'.repeat(max + 1)}")}`))).toContain(
      'argument_too_long',
    );
    expect(codes(parseTemplate(`{a:truncate(${'9'.repeat(max + 1)})}`))).toContain(
      'argument_too_long',
    );
  });

  test('an overlong key is reported once, as too long, and posted as written', () => {
    const key = 'a'.repeat(PLACEHOLDER_LIMITS.keyLength + 1);
    const parsed = parseTemplate(`x{${key}}y`);

    expect(codes(parsed)).toEqual(['key_too_long']);
    expect(parsed.diagnostics[0]?.severity).toBe('error');
    expect(parsed.diagnostics[0]?.span).toEqual({ start: 1, end: 2 + key.length });
    expect(parsed.tokens.every((token) => token.kind === 'text')).toBe(true);
    expect(render(`x{${key}}y`).output).toBe(`x{${key}}y`);
    expect(codes(parseTemplate(`{${'a'.repeat(PLACEHOLDER_LIMITS.keyLength)}}`))).toEqual([]);
  });

  test('diagnostics stop at their own limit', () => {
    expect(parseTemplate('} '.repeat(300)).diagnostics).toHaveLength(
      PLACEHOLDER_LIMITS.diagnostics,
    );
  });
});

describe('reserved keys', () => {
  for (const source of [
    '{__proto__}',
    '{constructor}',
    '{prototype}',
    '{_secret}',
    '{member.constructor}',
    '{server.__proto__.name}',
  ]) {
    test(`${source} never resolves`, () => {
      const key = source.slice(1, -1);

      expect(registry.resolve(key)).toBeUndefined();
      expect(codes(validateTemplate(source, { registry, field: 'discord_text' }))).toEqual([
        'forbidden_key',
      ]);
      expect(render(source).output).toBe(source);
    });
  }
});
