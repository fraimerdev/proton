import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { POLL_MAX_QUESTION_LENGTH } from '../../src/actions/payloads.ts';
import {
  type MessageTemplate,
  messageTemplateSchema,
  renderTemplate,
  type TemplateVars,
} from '../../src/messages/template.ts';

function template(value: unknown): MessageTemplate {
  return messageTemplateSchema.parse(value);
}

function render(
  subject: MessageTemplate,
  vars: TemplateVars = {},
): { template: MessageTemplate; unknown: string[] } {
  const rendered = renderTemplate(subject, vars);
  if (!rendered.ok) throw new Error(rendered.humanReason);
  return rendered;
}

describe('messageTemplateSchema', () => {
  test('accepts a template that is only content', () => {
    expect(messageTemplateSchema.safeParse({ content: 'Welcome!' }).success).toBe(true);
  });

  test('accepts a template that is only an embed', () => {
    expect(messageTemplateSchema.safeParse({ embeds: [{ title: 'Welcome' }] }).success).toBe(true);
  });

  test('refuses a template that would render to nothing, and says what is missing', () => {
    const parsed = messageTemplateSchema.safeParse({});

    expect(parsed.success).toBe(false);
    expect(parsed.success ? '' : parsed.error.issues[0]?.message).toContain(
      'content, an embed, a component or a poll',
    );
  });

  test('refuses an empty content string for the same reason', () => {
    expect(messageTemplateSchema.safeParse({ content: '' }).success).toBe(false);
  });

  test('has no channel to send to — a template is not a message', () => {
    expect(Object.keys(messageTemplateSchema.shape)).toEqual([
      'content',
      'embeds',
      'components',
      'poll',
      'flags',
    ]);
  });
});

describe('renderTemplate', () => {
  test('substitutes a flat, dotted placeholder in content', () => {
    const rendered = render(template({ content: 'Welcome {user.name}!' }), {
      'user.name': 'Ada',
    });

    expect(rendered.template.content).toBe('Welcome Ada!');
    expect(rendered.unknown).toEqual([]);
  });

  test('reaches into embeds, not just content', () => {
    const rendered = render(
      template({ embeds: [{ title: 'Hi {user.name}', fields: [{ value: '{guild.name}' }] }] }),
      { 'user.name': 'Ada', 'guild.name': 'Proton' },
    );

    expect(rendered.template.embeds).toEqual([{ title: 'Hi Ada', fields: [{ value: 'Proton' }] }]);
  });

  test('reaches into components', () => {
    const rendered = render(
      template({ components: [{ type: 1, components: [{ label: 'Say hi to {user.name}' }] }] }),
      { 'user.name': 'Ada' },
    );

    expect(rendered.template.components).toEqual([
      { type: 1, components: [{ label: 'Say hi to Ada' }] },
    ]);
  });

  test('renders numbers and booleans as text', () => {
    const rendered = render(template({ content: '{level} {member.boosting}' }), {
      level: 7,
      'member.boosting': true,
    });

    expect(rendered.template.content).toBe('7 true');
  });

  test('leaves an unknown placeholder exactly as written and reports it', () => {
    const rendered = render(template({ content: 'Welcome {user.nmae}!' }), {
      'user.name': 'Ada',
    });

    expect(rendered.template.content).toBe('Welcome {user.nmae}!');
    expect(rendered.unknown).toEqual(['user.nmae']);
  });

  test('reports each unknown placeholder once, however often it appears', () => {
    const rendered = render(template({ content: '{a} {a}', embeds: [{ title: '{a} {b}' }] }), {});

    expect(rendered.unknown).toEqual(['a', 'b']);
  });

  test('a failed placeholder never costs the message', () => {
    const rendered = render(template({ content: 'Hi {nobody}, welcome to {guild.name}' }), {
      'guild.name': 'Proton',
    });

    expect(rendered.template.content).toBe('Hi {nobody}, welcome to Proton');
  });

  test('does not resolve inherited object keys — {constructor} is not a variable', () => {
    const rendered = render(template({ content: '{constructor} {toString}' }), {
      'user.name': 'Ada',
    });

    expect(rendered.template.content).toBe('{constructor} {toString}');
    expect(rendered.unknown).toEqual(['constructor', 'toString']);
  });

  test('leaves the original template untouched', () => {
    const original = template({ content: 'Welcome {user.name}' });
    render(original, { 'user.name': 'Ada' });

    expect(original.content).toBe('Welcome {user.name}');
  });

  test('a value that looks like a placeholder is inserted, never expanded again', () => {
    const rendered = render(template({ content: 'Hi {a}' }), {
      a: '{b}',
      b: 'expanded',
    });

    expect(rendered.template.content).toBe('Hi {b}');
    expect(rendered.unknown).toEqual([]);
  });

  test('reports an unknown placeholder found only in a nested embed field', () => {
    const rendered = render(
      template({
        embeds: [
          { title: 'Welcome', fields: [{ name: 'Joined', value: '{member.joined_at}' }] },
          { footer: { text: 'Member #{guild.member_count}' } },
        ],
      }),
      {},
    );

    expect(rendered.unknown.sort()).toEqual(['guild.member_count', 'member.joined_at']);
  });

  test('reports an unknown placeholder found only inside a component label', () => {
    const rendered = render(
      template({ components: [{ type: 1, components: [{ label: 'Claim {reward.name}' }] }] }),
      {},
    );

    expect(rendered.unknown).toEqual(['reward.name']);
  });

  test('substitutes inside a poll, which is neither content nor an embed', () => {
    const poll = {
      question: { text: 'Best day for {guild.name}?' },
      answers: [{ poll_media: { text: 'Saturday' } }],
    };
    const rendered = render(template({ poll }), { 'guild.name': 'Proton' });

    expect(rendered.template.poll).toEqual({
      question: { text: 'Best day for Proton?' },
      answers: [{ poll_media: { text: 'Saturday' } }],
    });
  });

  test('an injected placeholder inside an embed is left alone there too', () => {
    const rendered = render(template({ embeds: [{ fields: [{ value: '{a}' }] }] }), {
      a: '{b}',
      b: 'expanded',
    });

    expect(rendered.template.embeds).toEqual([{ fields: [{ value: '{b}' }] }]);
  });

  test('a template it calls valid really is — the caller can send it unchecked', () => {
    const rendered = render(template({ content: 'Welcome {user.name}' }), { 'user.name': 'Ada' });

    expect(messageTemplateSchema.safeParse(rendered.template).success).toBe(true);
  });
});

describe('substitution only ever lengthens a string, so the result is re-checked', () => {
  test('a variable that overflows the content cap is refused, not typed as valid', () => {
    const rendered = renderTemplate(template({ content: '{intro}' }), {
      intro: 'x'.repeat(2500),
    });

    expect(rendered.ok).toBe(false);
    expect(rendered.ok ? '' : rendered.humanReason).toContain('content');
  });

  test('a variable that empties the only content leaves nothing to send, and says so', () => {
    const rendered = renderTemplate(template({ content: '{a}' }), { a: '' });

    expect(rendered.ok).toBe(false);
    expect(rendered.ok ? '' : rendered.humanReason).toContain(
      'content, an embed, a component or a poll',
    );
  });

  test('an overlong poll question is caught too, not only content', () => {
    const rendered = renderTemplate(
      template({
        poll: { question: { text: '{q}' }, answers: [{ poll_media: { text: 'Yes' } }] },
      }),
      { q: 'q'.repeat(POLL_MAX_QUESTION_LENGTH + 1) },
    );

    expect(rendered.ok).toBe(false);
    expect(rendered.ok ? '' : rendered.humanReason).toContain('poll question');
  });

  test('the placeholders it could not resolve are reported even when the result is refused', () => {
    const rendered = renderTemplate(template({ content: '{intro}{missing}' }), {
      intro: 'x'.repeat(2500),
    });

    expect(rendered.ok).toBe(false);
    expect(rendered.unknown).toEqual(['missing']);
  });
});

const varsArb: fc.Arbitrary<TemplateVars> = fc.dictionary(
  fc.constantFrom('user.name', 'guild.name', 'level', 'a', 'b'),
  fc.oneof(
    fc.string({ unit: fc.constantFrom('Ada', 'x', ' ', '1'), maxLength: 6 }),
    fc.integer(),
    fc.boolean(),
  ),
);

const templateArb: fc.Arbitrary<MessageTemplate> = fc
  .string({
    unit: fc.constantFrom('{user.name}', '{a}', '{missing}', ' ', 'x', '{', '}', '.'),
    minLength: 1,
    maxLength: 10,
  })
  .map((content) => ({ content, embeds: [{ title: content, fields: [{ value: content }] }] }));

describe('rendering properties', () => {
  test('rendering with no variables changes nothing', () => {
    fc.assert(
      fc.property(templateArb, (subject) => {
        expect(render(subject, {}).template).toEqual(subject);
      }),
    );
  });

  test('a substituted value is never scanned for placeholders of its own', () => {
    fc.assert(
      fc.property(varsArb, (vars) => {
        const rendered = render(template({ content: '{a}' }), { ...vars, a: '{b}' });

        expect(rendered.template.content).toBe('{b}');
      }),
    );
  });

  test('a value naming a defined variable still never reaches that variable’s value', () => {
    const filler = fc.string({ unit: fc.constantFrom('x', ' ', '.', '{', '}'), maxLength: 5 });

    fc.assert(
      fc.property(filler, filler, (before, after) => {
        const rendered = render(template({ content: '{a}' }), {
          a: `${before}{b}${after}`,
          b: 'guild-owner',
        });

        expect(rendered.template.content).toBe(`${before}{b}${after}`);
        expect(rendered.unknown).toEqual([]);
      }),
    );
  });

  test('every string in the tree gets the same substitution, however deep it sits', () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom('Ada', 'x', ' '), maxLength: 6 }), (value) => {
        const rendered = render(
          template({
            content: '{a}',
            embeds: [{ title: '{a}', fields: [{ value: '{a}' }], footer: { text: '{a}' } }],
            components: [{ type: 1, components: [{ label: '{a}' }] }],
          }),
          { a: value },
        );

        expect(rendered.template).toEqual({
          content: value,
          embeds: [{ title: value, fields: [{ value }], footer: { text: value } }],
          components: [{ type: 1, components: [{ label: value }] }],
        });
      }),
    );
  });

  test('unknown is exactly the placeholders the template used and the vars did not name', () => {
    fc.assert(
      fc.property(templateArb, varsArb, (subject, vars) => {
        const used = (
          String(subject.content).match(/\{[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*\}/g) ?? []
        ).map((placeholder) => placeholder.slice(1, -1));

        const rendered = render(subject, vars);

        for (const name of used) {
          expect(rendered.unknown.includes(name)).toBe(!Object.hasOwn(vars, name));
        }

        for (const name of rendered.unknown) {
          expect(used).toContain(name);
        }
      }),
    );
  });
});
