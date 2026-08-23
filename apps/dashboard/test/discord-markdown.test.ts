import { describe, expect, it } from 'bun:test';
import { type MarkdownNode, parseDiscordMarkdown } from '../src/lib/discord-markdown.ts';

function blocks(input: string): MarkdownNode[] {
  return parseDiscordMarkdown(input);
}

function inline(input: string): MarkdownNode[] {
  const [first, ...rest] = parseDiscordMarkdown(input);
  if (first?.kind !== 'paragraph') {
    throw new Error(
      `expected a single paragraph, got ${JSON.stringify(parseDiscordMarkdown(input))}`,
    );
  }
  expect(rest).toEqual([]);

  return first.children;
}

function text(value: string): MarkdownNode {
  return { kind: 'text', value };
}

function flatten(nodes: MarkdownNode[]): string {
  return nodes
    .map((node) => {
      if (node.kind === 'text' || node.kind === 'code') return node.value;
      if (node.kind === 'codeBlock') return node.code;
      if ('children' in node) return flatten(node.children);
      if (node.kind === 'list') return node.items.map(flatten).join('');

      return '';
    })
    .join('');
}

describe('inline emphasis', () => {
  it('parses bold', () => {
    expect(inline('**bold**')).toEqual([{ kind: 'bold', children: [text('bold')] }]);
  });

  it('parses both italic markers', () => {
    expect(inline('*a*')).toEqual([{ kind: 'italic', children: [text('a')] }]);
    expect(inline('_a_')).toEqual([{ kind: 'italic', children: [text('a')] }]);
  });

  it('parses underline, strike and spoiler', () => {
    expect(inline('__u__')).toEqual([{ kind: 'underline', children: [text('u')] }]);
    expect(inline('~~s~~')).toEqual([{ kind: 'strike', children: [text('s')] }]);
    expect(inline('||hidden||')).toEqual([{ kind: 'spoiler', children: [text('hidden')] }]);
  });

  it('nests bold italic', () => {
    expect(inline('***both***')).toEqual([
      { kind: 'bold', children: [{ kind: 'italic', children: [text('both')] }] },
    ]);
  });

  it('nests mixed containers', () => {
    expect(inline('**bold with _italic_ inside**')).toEqual([
      {
        kind: 'bold',
        children: [
          text('bold with '),
          { kind: 'italic', children: [text('italic')] },
          text(' inside'),
        ],
      },
    ]);
  });

  it('nests a spoiler inside a strike', () => {
    expect(inline('~~gone ||poof||~~')).toEqual([
      {
        kind: 'strike',
        children: [text('gone '), { kind: 'spoiler', children: [text('poof')] }],
      },
    ]);
  });

  it('keeps surrounding text alongside emphasis', () => {
    expect(inline('a **b** c')).toEqual([
      text('a '),
      { kind: 'bold', children: [text('b')] },
      text(' c'),
    ]);
  });

  it('leaves unmatched delimiters as literal text', () => {
    expect(inline('**oops')).toEqual([text('**oops')]);
    expect(inline('||half')).toEqual([text('||half')]);
    expect(inline('~~nope')).toEqual([text('~~nope')]);
    expect(inline('a * b')).toEqual([text('a * b')]);
  });

  it('leaves empty delimiter runs as literal text', () => {
    expect(inline('****')).toEqual([text('****')]);
    expect(inline('||||')).toEqual([text('||||')]);
  });

  it('does not italicise inside a word with underscores', () => {
    expect(inline('snake_case_name')).toEqual([text('snake_case_name')]);
    expect(inline('a_b_c d_e_f')).toEqual([text('a_b_c d_e_f')]);
  });

  it('does italicise mid-word with asterisks', () => {
    expect(inline('sna*ke*case')).toEqual([
      text('sna'),
      { kind: 'italic', children: [text('ke')] },
      text('case'),
    ]);
  });

  it('does not treat an underscore closer inside a word as a closer', () => {
    expect(inline('_start end_word')).toEqual([text('_start end_word')]);
  });

  it('does not italicise asterisks used as arithmetic or bullets', () => {
    expect(inline('2 * 3 * 4')).toEqual([text('2 * 3 * 4')]);
    expect(inline('use * for bullets and * for stars')).toEqual([
      text('use * for bullets and * for stars'),
    ]);
  });

  it('needs a non space on both sides of a single asterisk', () => {
    expect(inline('*a *')).toEqual([text('*a *')]);
    expect(inline('x * a*')).toEqual([text('x * a*')]);
    expect(inline('*a b*')).toEqual([{ kind: 'italic', children: [text('a b')] }]);
  });

  it('still emphasises padded spaces for every other delimiter', () => {
    expect(inline('** a **')).toEqual([{ kind: 'bold', children: [text(' a ')] }]);
    expect(inline('__ a __')).toEqual([{ kind: 'underline', children: [text(' a ')] }]);
    expect(inline('~~ a ~~')).toEqual([{ kind: 'strike', children: [text(' a ')] }]);
    expect(inline('|| a ||')).toEqual([{ kind: 'spoiler', children: [text(' a ')] }]);
    expect(inline('_ a _')).toEqual([{ kind: 'italic', children: [text(' a ')] }]);
    expect(inline('*** a ***')).toEqual([
      { kind: 'bold', children: [{ kind: 'italic', children: [text(' a ')] }] },
    ]);
  });
});

describe('escapes', () => {
  it('escapes markdown punctuation', () => {
    expect(inline('\\*not italic\\*')).toEqual([text('*not italic*')]);
    expect(inline('\\*\\*not bold\\*\\*')).toEqual([text('**not bold**')]);
    expect(inline('\\|\\|not a spoiler\\|\\|')).toEqual([text('||not a spoiler||')]);
  });

  it('escapes a backslash itself', () => {
    expect(inline('\\\\*italic*')).toEqual([
      text('\\'),
      { kind: 'italic', children: [text('italic')] },
    ]);
  });

  it('escapes entity brackets', () => {
    expect(inline('\\<@123>')).toEqual([text('<@123>')]);
  });

  it('leaves a backslash before a letter alone', () => {
    expect(inline('C:\\path')).toEqual([text('C:\\path')]);
  });

  it('does not let an escaped delimiter close emphasis', () => {
    expect(inline('**bold \\** still bold**')).toEqual([
      { kind: 'bold', children: [text('bold ** still bold')] },
    ]);
  });
});

describe('code', () => {
  it('parses single and double backtick code', () => {
    expect(inline('`x`')).toEqual([{ kind: 'code', value: 'x' }]);
    expect(inline('``a `b` c``')).toEqual([{ kind: 'code', value: 'a `b` c' }]);
  });

  it('parses no markdown inside inline code', () => {
    expect(inline('`**bold** <@123> ||s||`')).toEqual([
      { kind: 'code', value: '**bold** <@123> ||s||' },
    ]);
  });

  it('leaves an unmatched backtick literal', () => {
    expect(inline('a ` b')).toEqual([text('a ` b')]);
  });

  it('does not let code hide inside emphasis scanning', () => {
    expect(inline('**bold `**` still**')).toEqual([
      { kind: 'bold', children: [text('bold '), { kind: 'code', value: '**' }, text(' still')] },
    ]);
  });

  it('parses a fenced block with a language', () => {
    expect(blocks('```ts\nconst a = 1;\n```')).toEqual([
      { kind: 'codeBlock', language: 'ts', code: 'const a = 1;' },
    ]);
  });

  it('parses a fenced block without a language', () => {
    expect(blocks('```\nplain\n```')).toEqual([{ kind: 'codeBlock', code: 'plain' }]);
  });

  it('parses a single line fence', () => {
    expect(blocks('```hello world```')).toEqual([{ kind: 'codeBlock', code: 'hello world' }]);
  });

  it('keeps every line of a multi line fence', () => {
    expect(blocks('```py\none\ntwo\n\nthree\n```')).toEqual([
      { kind: 'codeBlock', language: 'py', code: 'one\ntwo\n\nthree' },
    ]);
  });

  it('parses no markdown inside a fenced block', () => {
    expect(blocks('```\n**bold** <@1> # heading\n- item\n```')).toEqual([
      { kind: 'codeBlock', code: '**bold** <@1> # heading\n- item' },
    ]);
  });

  it('treats an unclosed fence as literal text', () => {
    expect(blocks('```js\nconst a = 1;')).toEqual([
      { kind: 'paragraph', children: [text('```js\nconst a = 1;')] },
    ]);
  });

  it('surrounds a fence with paragraphs', () => {
    expect(blocks('before\n```\ncode\n```\nafter')).toEqual([
      { kind: 'paragraph', children: [text('before')] },
      { kind: 'codeBlock', code: 'code' },
      { kind: 'paragraph', children: [text('after')] },
    ]);
  });
});

describe('entities', () => {
  it('parses user mentions in both forms', () => {
    expect(inline('<@123>')).toEqual([{ kind: 'userMention', id: '123' }]);
    expect(inline('<@!123>')).toEqual([{ kind: 'userMention', id: '123' }]);
  });

  it('parses role and channel mentions', () => {
    expect(inline('<@&456>')).toEqual([{ kind: 'roleMention', id: '456' }]);
    expect(inline('<#789>')).toEqual([{ kind: 'channelMention', id: '789' }]);
  });

  it('parses slash commands including subcommands', () => {
    expect(inline('</ban:1>')).toEqual([{ kind: 'slashCommand', name: 'ban', id: '1' }]);
    expect(inline('</case list:22>')).toEqual([
      { kind: 'slashCommand', name: 'case list', id: '22' },
    ]);
  });

  it('parses static and animated emoji', () => {
    expect(inline('<:proton:1234>')).toEqual([
      { kind: 'emoji', name: 'proton', id: '1234', animated: false },
    ]);
    expect(inline('<a:spin:1234>')).toEqual([
      { kind: 'emoji', name: 'spin', id: '1234', animated: true },
    ]);
  });

  it('parses timestamps with and without a style', () => {
    expect(inline('<t:1234567890>')).toEqual([{ kind: 'timestamp', unix: 1234567890, style: 'f' }]);

    for (const style of ['t', 'T', 'd', 'D', 'f', 'F', 's', 'S', 'R']) {
      expect(inline(`<t:1234567890:${style}>`)).toEqual([
        { kind: 'timestamp', unix: 1234567890, style },
      ]);
    }
  });

  it('parses every guild navigation target', () => {
    for (const target of ['customize', 'browse', 'guide', 'linked-roles']) {
      expect(inline(`<id:${target}>`)).toEqual([{ kind: 'guildNav', target }]);
    }
  });

  it('parses a linked role navigation target', () => {
    expect(inline('<id:linked-roles:165511591545143296>')).toEqual([
      { kind: 'guildNav', target: 'linked-roles', roleId: '165511591545143296' },
    ]);
    expect(inline('<id:browse:1>')).toEqual([text('<id:browse:1>')]);
  });

  it('parses bare everyone and here', () => {
    expect(inline('@everyone')).toEqual([{ kind: 'everyone', which: 'everyone' }]);
    expect(inline('hey @here now')).toEqual([
      text('hey '),
      { kind: 'everyone', which: 'here' },
      text(' now'),
    ]);
  });

  it('does not fire everyone mid-word', () => {
    expect(inline('name@here.example')).toEqual([text('name@here.example')]);
  });

  it('leaves malformed entities as text', () => {
    expect(inline('<@abc>')).toEqual([text('<@abc>')]);
    expect(inline('<t:>')).toEqual([text('<t:>')]);
    expect(inline('<id:nope>')).toEqual([text('<id:nope>')]);
    expect(inline('<')).toEqual([text('<')]);
    expect(inline('a < b > c')).toEqual([text('a < b > c')]);
  });

  it('parses entities beside emphasis', () => {
    expect(inline('**<@1>**')).toEqual([
      { kind: 'bold', children: [{ kind: 'userMention', id: '1' }] },
    ]);
  });
});

describe('links', () => {
  it('parses a masked link', () => {
    expect(inline('[label](https://example.com)')).toEqual([
      { kind: 'link', url: 'https://example.com', children: [text('label')] },
    ]);
  });

  it('parses markdown inside a link label', () => {
    expect(inline('[**bold**](https://example.com)')).toEqual([
      {
        kind: 'link',
        url: 'https://example.com',
        children: [{ kind: 'bold', children: [text('bold')] }],
      },
    ]);
  });

  it('strips embed suppressing angle brackets', () => {
    expect(inline('[x](<https://example.com>)')).toEqual([
      { kind: 'link', url: 'https://example.com', children: [text('x')] },
    ]);
  });

  it('strips angle brackets only as a balanced pair', () => {
    expect(inline('[x](https://example.com/?q=a>)')).toEqual([
      { kind: 'link', url: 'https://example.com/?q=a>', children: [text('x')] },
    ]);
    expect(inline('[x](<https://example.com>tail)')).toEqual([
      text('[x](<https://example.com>tail)'),
    ]);
  });

  it('rejects unsafe schemes', () => {
    expect(inline('[click](javascript:alert(1))')).toEqual([text('[click](javascript:alert(1))')]);
    expect(inline('[click](data:text/html,<script>)')).toEqual([
      text('[click](data:text/html,<script>)'),
    ]);
  });

  it('leaves an incomplete link as text', () => {
    expect(inline('[label]')).toEqual([text('[label]')]);
    expect(inline('[label](')).toEqual([text('[label](')]);
    expect(inline('[label](https://a b)')).toEqual([text('[label](https://a b)')]);
  });

  it('does not parse a link inside a link label', () => {
    expect(inline('[a [b](https://inner.example)](https://outer.example)')).toEqual([
      {
        kind: 'link',
        url: 'https://outer.example',
        children: [text('a [b](https://inner.example)')],
      },
    ]);
  });
});

describe('blocks', () => {
  it('parses a bare paragraph', () => {
    expect(blocks('hello')).toEqual([{ kind: 'paragraph', children: [text('hello')] }]);
  });

  it('keeps consecutive lines in one paragraph and splits on a blank line', () => {
    expect(blocks('one\ntwo\n\nthree')).toEqual([
      { kind: 'paragraph', children: [text('one\ntwo')] },
      { kind: 'paragraph', children: [text('three')] },
    ]);
  });

  it('parses all three heading levels', () => {
    expect(blocks('# one\n## two\n### three')).toEqual([
      { kind: 'heading', level: 1, children: [text('one')] },
      { kind: 'heading', level: 2, children: [text('two')] },
      { kind: 'heading', level: 3, children: [text('three')] },
    ]);
  });

  it('needs a space for a heading', () => {
    expect(blocks('#hashtag')).toEqual([{ kind: 'paragraph', children: [text('#hashtag')] }]);
    expect(blocks('#### four')).toEqual([{ kind: 'paragraph', children: [text('#### four')] }]);
  });

  it('parses headings only at the start of a line', () => {
    expect(blocks('a # not a heading')).toEqual([
      { kind: 'paragraph', children: [text('a # not a heading')] },
    ]);
  });

  it('parses subtext', () => {
    expect(blocks('-# small print')).toEqual([
      { kind: 'subtext', children: [text('small print')] },
    ]);
  });

  it('parses inline markdown inside a heading', () => {
    expect(blocks('# a **b**')).toEqual([
      {
        kind: 'heading',
        level: 1,
        children: [text('a '), { kind: 'bold', children: [text('b')] }],
      },
    ]);
  });

  it('parses an unordered list with either marker', () => {
    expect(blocks('- one\n* two')).toEqual([
      {
        kind: 'list',
        ordered: false,
        items: [[text('one')], [text('two')]],
      },
    ]);
  });

  it('parses an ordered list and keeps its start', () => {
    expect(blocks('3. three\n4. four')).toEqual([
      {
        kind: 'list',
        ordered: true,
        items: [[text('three')], [text('four')]],
        start: 3,
      },
    ]);
  });

  it('starts ordered lists at one by default', () => {
    const [list] = blocks('1. a');
    expect(list).toEqual({ kind: 'list', ordered: true, items: [[text('a')]], start: 1 });
  });

  it('splits an ordered list from an unordered one', () => {
    expect(blocks('- a\n1. b').map((node) => node.kind)).toEqual(['list', 'list']);
  });

  it('parses inline markdown inside list items', () => {
    expect(blocks('- **bold** item')).toEqual([
      {
        kind: 'list',
        ordered: false,
        items: [[{ kind: 'bold', children: [text('bold')] }, text(' item')]],
      },
    ]);
  });

  it('ends a list at the first non list line', () => {
    expect(blocks('- a\nafter')).toEqual([
      { kind: 'list', ordered: false, items: [[text('a')]] },
      { kind: 'paragraph', children: [text('after')] },
    ]);
  });

  it('parses a single line quote', () => {
    expect(blocks('> quoted\nplain')).toEqual([
      { kind: 'quote', children: [{ kind: 'paragraph', children: [text('quoted')] }] },
      { kind: 'paragraph', children: [text('plain')] },
    ]);
  });

  it('merges consecutive quote lines', () => {
    expect(blocks('> one\n> two')).toEqual([
      { kind: 'quote', children: [{ kind: 'paragraph', children: [text('one\ntwo')] }] },
    ]);
  });

  it('swallows the rest of the message with a triple quote', () => {
    expect(blocks('>>> one\ntwo\n\nthree')).toEqual([
      {
        kind: 'quote',
        children: [
          { kind: 'paragraph', children: [text('one\ntwo')] },
          { kind: 'paragraph', children: [text('three')] },
        ],
      },
    ]);
  });

  it('parses blocks inside a quote', () => {
    expect(blocks('> # head\n> - item')).toEqual([
      {
        kind: 'quote',
        children: [
          { kind: 'heading', level: 1, children: [text('head')] },
          { kind: 'list', ordered: false, items: [[text('item')]] },
        ],
      },
    ]);
  });

  it('does not nest quotes', () => {
    expect(blocks('> > inner')).toEqual([
      { kind: 'quote', children: [{ kind: 'paragraph', children: [text('> inner')] }] },
    ]);
  });

  it('needs a space for a quote', () => {
    expect(blocks('>not a quote')).toEqual([
      { kind: 'paragraph', children: [text('>not a quote')] },
    ]);
  });

  it('normalises carriage returns', () => {
    expect(blocks('one\r\ntwo')).toEqual([{ kind: 'paragraph', children: [text('one\ntwo')] }]);
  });

  it('returns nothing for empty or blank input', () => {
    expect(blocks('')).toEqual([]);
    expect(blocks('\n\n   \n')).toEqual([]);
  });
});

describe('adversarial input', () => {
  const budget = 2_000;

  function within(input: string): MarkdownNode[] {
    const started = Date.now();
    const parsed = parseDiscordMarkdown(input);
    expect(Date.now() - started).toBeLessThan(budget);

    return parsed;
  }

  it('survives two thousand unmatched asterisks', () => {
    const nodes = within('*'.repeat(2_000));
    expect(nodes).toHaveLength(1);
  });

  it('survives a wall of pipes', () => {
    expect(within('|'.repeat(4_096))).toHaveLength(1);
  });

  it('survives deeply nested spoilers', () => {
    const nodes = within(`${'||'.repeat(500)}x${'||'.repeat(500)}`);
    expect(nodes).toHaveLength(1);
    expect(flatten(nodes)).toContain('x');
  });

  it('survives alternating delimiters', () => {
    expect(within('*_~|`'.repeat(800))).toHaveLength(1);
  });

  it('survives an unclosed fence at the end of a long message', () => {
    expect(within(`${'a\n'.repeat(500)}\`\`\``)).not.toHaveLength(0);
  });

  it('survives many fences', () => {
    expect(within('```'.repeat(1_000))).not.toHaveLength(0);
  });

  it('survives many unclosed brackets', () => {
    expect(within('[a](https://x.example'.repeat(200))).toHaveLength(1);
  });

  it('survives nested brackets', () => {
    expect(within('['.repeat(2_000))).toHaveLength(1);
  });

  it('survives empty link openers at a full message length', () => {
    expect(within('[]('.repeat(1_365))).toHaveLength(1);
  });

  it('survives padded asterisks', () => {
    expect(within('a * '.repeat(1_024))).toHaveLength(1);
  });

  it('survives malformed entities', () => {
    expect(within('<@'.repeat(2_000))).toHaveLength(1);
    expect(within('<a:'.repeat(1_000))).toHaveLength(1);
  });

  it('survives a mixed pathological message', () => {
    const soup = '**`||<@1>*_~~[a](https://x.example)\\'.repeat(120);
    expect(within(soup).length).toBeGreaterThan(0);
  });

  it('never loses characters to a paragraph of plain text', () => {
    const plain = 'the quick brown fox '.repeat(50).trim();
    expect(flatten(within(plain))).toBe(plain);
  });
});
