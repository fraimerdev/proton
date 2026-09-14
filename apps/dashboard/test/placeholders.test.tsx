import { describe, expect, test } from 'bun:test';
import {
  type PlaceholderSurface,
  placeholderValue,
  SAMPLE_BOT,
  SAMPLE_MEMBER,
  SAMPLE_NOW,
  SAMPLE_SERVER,
  type SurfaceDiagnostic,
  type SurfaceSample,
} from '@proton/core/placeholders';
import {
  renderTicketChannelName,
  renderTicketWelcome,
  TICKET_NAME_SURFACE,
  TICKET_WELCOME_SURFACE,
} from '@proton/module-tickets/placeholders';
import {
  DEFAULT_BOOST_GREETING,
  DEFAULT_GOODBYE_GREETING,
  DEFAULT_WELCOME_GREETING,
  type GreetingMessage,
} from '@proton/module-welcome/config';
import {
  renderGreetingMessage,
  WELCOME_BOOST_SURFACE,
  WELCOME_JOIN_SURFACE,
  WELCOME_LEAVE_SURFACE,
} from '@proton/module-welcome/placeholders';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  TemplateDiagnostics,
  visibleDiagnostics,
} from '../src/components/placeholders/template-diagnostics.tsx';
import {
  previewCaption,
  previewMessage,
  previewText,
  SAMPLE_MENTION_NAMES,
  sampleMentionNames,
} from '../src/lib/placeholder-preview.ts';

function firstSample<F>(surface: PlaceholderSurface<F>): SurfaceSample<F> {
  const [sample] = surface.samples;
  if (sample === undefined) throw new Error(`${surface.id} has no sample`);
  return sample;
}

function diagnostic(severity: SurfaceDiagnostic['severity'], message: string): SurfaceDiagnostic {
  const code =
    severity === 'error'
      ? 'unknown_modifier'
      : severity === 'warning'
        ? 'lone_brace'
        : 'legacy_alias';
  return { code, severity, message, span: null };
}

describe('TemplateDiagnostics', () => {
  const list = [
    diagnostic('info', 'i1'),
    diagnostic('warning', 'w1'),
    diagnostic('error', 'e1'),
    diagnostic('warning', 'w2'),
    diagnostic('error', 'e1'),
    diagnostic('warning', 'w3'),
  ];

  test('lists errors, then warnings, at most three, hiding info while others show', () => {
    const { shown, more } = visibleDiagnostics(list);

    expect(shown.map(({ message }) => message)).toEqual(['e1', 'w1', 'w2']);
    expect(more).toBe(1);
    expect(visibleDiagnostics([diagnostic('info', 'only')]).shown).toHaveLength(1);
  });

  test('renders tones under the id the field describes itself with', () => {
    const markup = renderToStaticMarkup(
      <TemplateDiagnostics id="title-diagnostics" diagnostics={list} />,
    );

    expect(markup).toContain('id="title-diagnostics"');
    expect(markup).toContain('class="field-error"');
    expect(markup).toContain('class="field-warning"');
    expect(markup).toContain('and 1 more');
    expect(markup).not.toContain('i1');
    expect(renderToStaticMarkup(<TemplateDiagnostics id="empty" diagnostics={[]} />)).toBe('');
  });
});

describe('placeholder previews', () => {
  const greetings = [
    [WELCOME_JOIN_SURFACE, DEFAULT_WELCOME_GREETING],
    [WELCOME_LEAVE_SURFACE, DEFAULT_GOODBYE_GREETING],
    [WELCOME_BOOST_SURFACE, DEFAULT_BOOST_GREETING],
  ] as const;

  test('previewMessage renders what the module sends for each sample', () => {
    for (const [surface, greeting] of greetings) {
      const message: GreetingMessage = {
        ...greeting,
        content: `${greeting.content ?? ''} {user.display_name} {server.member_count:number} {now:date}`,
      };

      for (const sample of surface.samples) {
        const sent = renderGreetingMessage(message, surface, sample.facts, SAMPLE_NOW);
        if (!sent.ok) throw new Error(sent.humanReason);

        const preview = previewMessage(surface, message, sample);
        expect(preview.message).toEqual(sent.message);
        expect(preview.problem).toBeUndefined();
        expect(preview.caption).toBe(sample.label);
        expect(preview.now).toBe(SAMPLE_NOW);
      }
    }
  });

  test('previewText renders what the module sends for each sample', () => {
    const welcome = firstSample(TICKET_WELCOME_SURFACE);
    const template = 'Hi {user.mention}, ticket #{ticket.number} about {ticket.answer.order}';
    const opening = previewText(
      TICKET_WELCOME_SURFACE,
      'types.0.welcomeMessage',
      template,
      welcome,
    );
    expect(opening.text).toBe(renderTicketWelcome(template, welcome.facts, SAMPLE_NOW));
    expect(opening.mentionNames.get(SAMPLE_MEMBER.user.id)).toBe('Fraimer');

    const name = firstSample(TICKET_NAME_SURFACE);
    const pattern = '{type}-{number}-{user} {server.name}';
    expect(previewText(TICKET_NAME_SURFACE, 'types.0.namePattern', pattern, name).text).toBe(
      renderTicketChannelName(pattern, name.facts, SAMPLE_NOW),
    );
  });

  test('says so when the real server name replaces the sample one', () => {
    const sample = firstSample(WELCOME_JOIN_SURFACE);
    const preview = previewMessage(WELCOME_JOIN_SURFACE, DEFAULT_WELCOME_GREETING, sample, {
      server: { ...SAMPLE_SERVER, name: 'Real Guild' },
    });

    expect(preview.caption).toBe("Sample: your server's name, sample member");
    expect(preview.message.content).toContain('Real Guild');
    expect(previewCaption(sample, { eventId: 'another' })).toBe(sample.label);
  });
});

describe('preview mention names', () => {
  const sample = firstSample(WELCOME_JOIN_SURFACE);
  const mentions: GreetingMessage = {
    ...DEFAULT_WELCOME_GREETING,
    content: '{user.mention} {bot.mention} {destination_channel.mention}',
  };

  test('always know the sample member and Proton', () => {
    expect(SAMPLE_MENTION_NAMES.get(SAMPLE_MEMBER.user.id)).toBe('Fraimer');
    expect(SAMPLE_MENTION_NAMES.get(SAMPLE_BOT.id)).toBe('Proton');
  });

  test('name every mention the sample writes, by the name the engine gives it', () => {
    const preview = previewMessage(WELCOME_JOIN_SURFACE, mentions, sample);

    expect(preview.message.content).toContain(`<@${SAMPLE_MEMBER.user.id}>`);
    expect(preview.message.content).toContain('<#100000000000000040>');
    expect(preview.mentionNames.get(SAMPLE_MEMBER.user.id)).toBe('Fraimer');
    expect(preview.mentionNames.get(SAMPLE_BOT.id)).toBe('Proton');
    expect(preview.mentionNames.get('100000000000000040')).toBe('welcome');
  });

  test('follow a real channel chosen on the page', () => {
    const preview = previewMessage(WELCOME_JOIN_SURFACE, mentions, sample, {
      destinationChannel: {
        id: '100000000000000777',
        name: 'general_chat',
        type: 0,
        parentId: null,
      },
    });

    expect(preview.message.content).toContain('<#100000000000000777>');
    expect(preview.mentionNames.get('100000000000000777')).toBe('general_chat');
  });

  test('read every mention in a list, and survive a lookup that throws', () => {
    const listed = sampleMentionNames(
      WELCOME_JOIN_SURFACE,
      () =>
        placeholderValue.list('mention', [
          placeholderValue.role('100000000000000020', 'Mods'),
          placeholderValue.channel('100000000000000041', 'rules'),
        ]),
      ['{user.mention}'],
    );
    expect(listed.get('100000000000000020')).toBe('Mods');
    expect(listed.get('100000000000000041')).toBe('rules');

    const failed = sampleMentionNames(WELCOME_JOIN_SURFACE, () => {
      throw new Error('unreadable');
    }, ['{user.mention}']);
    expect([...failed]).toEqual([...SAMPLE_MENTION_NAMES]);
  });
});
