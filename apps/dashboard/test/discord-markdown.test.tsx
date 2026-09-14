import { describe, expect, test } from 'bun:test';
import type { ProtonMessage } from '@proton/core';
import { SAMPLE_MEMBER, SAMPLE_NOW } from '@proton/core/placeholders';
import { DEFAULT_WELCOME_GREETING, type GreetingMessage } from '@proton/module-welcome/config';
import { WELCOME_JOIN_SURFACE } from '@proton/module-welcome/placeholders';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DiscordMarkdown,
  formatDiscordTimestamp,
  InlineDiscordMarkdown,
  type MentionNames,
} from '../src/components/discord/markdown.tsx';
import { DiscordPreview } from '../src/components/discord/message-preview.tsx';
import { previewMessage } from '../src/lib/placeholder-preview.ts';

const SECONDS = SAMPLE_NOW / 1000;

const NAMES: MentionNames = new Map([
  [SAMPLE_MEMBER.user.id, 'Fraimer'],
  ['100000000000000020', 'Mods'],
  ['100000000000000040', 'welcome'],
]);

const UK_UTC = { locale: 'en-GB', timeZone: 'UTC' };

function markdown(text: string, mentionNames?: MentionNames, now?: number): string {
  return renderToStaticMarkup(
    <DiscordMarkdown text={text} mentionNames={mentionNames} now={now} />,
  );
}

function preview(message: Partial<ProtonMessage>, mentionNames?: MentionNames): string {
  return renderToStaticMarkup(<DiscordPreview message={message} mentionNames={mentionNames} />);
}

describe('backslash escapes', () => {
  test('show the escaped character without its backslash', () => {
    expect(markdown('general\\_chat')).toContain('general_chat');
    expect(markdown('general\\_chat')).not.toContain('\\');
    expect(markdown('\\\\')).toContain('<span>\\</span>');
  });

  test('stop an escaped character from starting markdown', () => {
    const stars = markdown('\\*\\*not bold\\*\\*');
    expect(stars).toContain('**not bold**');
    expect(stars).not.toContain('<strong>');

    const mention = markdown('\\<@100000000000000010>', NAMES);
    expect(mention).toContain('&lt;@100000000000000010&gt;');
    expect(mention).not.toContain('dc-mention');
  });

  test('keep an escaped character inside the markdown around it', () => {
    expect(markdown('**a\\*b**')).toContain('<strong>a*b</strong>');
    expect(markdown('*a\\*b*')).toContain('<em>a*b</em>');
    expect(markdown('~~x\\~y~~')).toContain('<s>x~y</s>');
  });

  test('turn an escaped line start into plain text', () => {
    const heading = markdown('\\# Title');
    expect(heading).not.toContain('dc-heading');
    expect(heading).toContain('# Title');

    const bullet = markdown('\\- item');
    expect(bullet).not.toContain('•');
    expect(bullet).toContain('- item');

    expect(markdown('\\-# small')).not.toContain('dc-small');
    expect(markdown('1\\. first')).toContain('1. first');
    expect(markdown('\\> quoted')).not.toContain('dc-blockquote');
  });

  test('leave code as written', () => {
    expect(markdown('`a\\_b`')).toContain('a\\_b');
    expect(markdown('```x\\*y```')).toContain('x\\*y');
    expect(markdown('```\nx\\*y\n```')).toContain('x\\*y');
  });

  test('preview a value the engine escaped the way Discord shows it', () => {
    const [sample] = WELCOME_JOIN_SURFACE.samples;
    if (sample === undefined) throw new Error('the welcome surface has no sample');

    const message: GreetingMessage = {
      ...DEFAULT_WELCOME_GREETING,
      content: 'Welcome to #{destination_channel.name}, {user.mention}!',
    };
    const rendered = previewMessage(WELCOME_JOIN_SURFACE, message, sample, {
      destinationChannel: {
        id: '100000000000000777',
        name: 'general_chat',
        type: 0,
        parentId: null,
      },
    });

    expect(rendered.message.content).toContain('general\\_chat');

    const markup = preview({ content: rendered.message.content }, rendered.mentionNames);
    expect(markup).toContain('Welcome to #general_chat, ');
    expect(markup).toContain('@Fraimer');
    expect(markup).not.toContain('\\');
  });
});

describe('fenced code', () => {
  test('a fence over several lines is one code block between the text around it', () => {
    const markup = markdown('Intro\n```js\nconst a = 1;\nconst b = 2;\n```\nAfter');

    expect(markup).toContain('<span>Intro</span>');
    expect(markup).toContain('<span class="dc-codeblock">const a = 1;\nconst b = 2;\n</span>');
    expect(markup).toContain('<span>After</span>');
    expect(markup).not.toContain('```');
    expect(markup.match(/display:block/g)).toHaveLength(3);
  });
});

describe('mentions', () => {
  test('show the name a preview knows', () => {
    const markup = markdown(
      '<@100000000000000010> <@!100000000000000010> <@&100000000000000020> <#100000000000000040>',
      NAMES,
    );

    expect(markup.match(/@Fraimer/g)).toHaveLength(2);
    expect(markup).toContain('@Mods');
    expect(markup).toContain('#welcome');
  });

  test('fall back to what kind of mention it is', () => {
    const markup = markdown(
      '<@1000000000000000011> <@&1000000000000000021> <#1000000000000000041>',
    );

    expect(markup).toContain('@user');
    expect(markup).toContain('@role');
    expect(markup).toContain('#channel');
  });
});

describe('timestamps', () => {
  test('each style is written the way Discord writes it', () => {
    const written = (style: string): string =>
      formatDiscordTimestamp(SECONDS, style, SAMPLE_NOW, UK_UTC) ?? '';

    expect(written('d')).toBe('14/09/2026');
    expect(written('t')).toBe('09:00');
    expect(written('T')).toBe('09:00:00');
    expect(written('D')).toBe('14 September 2026');
    expect(written('f')).toContain('14 September 2026');
    expect(written('f')).toContain('09:00');
    expect(written('F')).toContain('Monday');
    expect(written('?')).toBe(written('f'));
    expect(new Set(['t', 'T', 'd', 'D', 'f', 'F'].map(written)).size).toBe(6);
  });

  test('a relative timestamp counts the largest whole unit from now', () => {
    const relative = (offset: number): string | undefined =>
      formatDiscordTimestamp(SECONDS + offset, 'R', SAMPLE_NOW, UK_UTC);

    expect(relative(0)).toBe('now');
    expect(relative(0.4)).toBe('now');
    expect(relative(90)).toBe('in 1 minute');
    expect(relative(7_200)).toBe('in 2 hours');
    expect(relative(-3 * 86_400)).toBe('3 days ago');
    expect(relative(-400 * 86_400)).toBe('last year');
  });

  test('a time Discord cannot show is left as written', () => {
    expect(formatDiscordTimestamp(1e20, 'f', SAMPLE_NOW)).toBeUndefined();
    expect(markdown('<t:100000000000000000000:f>')).toContain('&lt;t:100000000000000000000:f&gt;');
  });

  test('the first paint uses the style, a fixed zone and the preview clock', () => {
    expect(markdown(`<t:${SECONDS}:d>`)).toContain('14/09/2026');
    expect(markdown(`<t:${SECONDS}:t>`)).toContain('09:00');
    expect(markdown(`<t:${SECONDS + 7_200}:R>`, undefined, SAMPLE_NOW)).toContain('in 2 hours');
    expect(markdown(`<t:${SECONDS}:R>`)).toContain('14 September 2026');
  });
});

describe('embed titles and field names', () => {
  test('take markdown and escapes, but show mentions and timestamps as written', () => {
    const markup = preview(
      {
        embeds: [
          {
            title: '**Bold** \\_x\\_ <@100000000000000010>',
            fields: [
              {
                name: '__Under__ \\* <t:1:R>',
                value: '<@100000000000000010> **v**',
                inline: false,
              },
            ],
          },
        ],
      },
      NAMES,
    );

    expect(markup).toContain('<strong>Bold</strong> _x_ &lt;@100000000000000010&gt;');
    expect(markup).toContain('<u>Under</u> * &lt;t:1:R&gt;');
    expect(markup).toContain('@Fraimer');
    expect(markup).toContain('<strong>v</strong>');
  });

  test('never turn a link into a link', () => {
    const markup = renderToStaticMarkup(<InlineDiscordMarkdown text="See https://prtn.xyz" />);

    expect(markup).toBe('See https://prtn.xyz');
  });
});
