import { describe, expect, test } from 'bun:test';
import { type DispatchName, dispatch } from '@proton/fixtures';
import { InteractionType } from 'discord-api-types/v10';
import type { EventType, ProtonEvent } from '../../src/events/types.ts';
import {
  readAutocompleteInteraction,
  readComponentInteraction,
  readModalInteraction,
} from '../../src/interactions/read.ts';

const GUILD = '900000000000000001';
const CHANNEL = '500000000000000001';
const USER = '100000000000000002';
const INTERACTION = '1500000000000000002';
const APPLICATION = '800000000000000001';
const ROLE = '700000000000000001';

function event(type: EventType, payload: unknown): ProtonEvent {
  return { id: 'evt_1', type, guildId: GUILD, occurredAt: 0, payload };
}

function interaction(interactionType: number, data: unknown): Record<string, unknown> {
  return {
    id: INTERACTION,
    application_id: APPLICATION,
    type: interactionType,
    guild_id: GUILD,
    channel_id: CHANNEL,
    token: 'a-token',
    data,
    member: { user: { id: USER, bot: false }, roles: [ROLE] },
  };
}

describe('readComponentInteraction', () => {
  const pressed = event(
    'interaction.component',
    interaction(3, { custom_id: 'proton:rolemenu:colours:red', component_type: 2 }),
  );

  test('reads who pressed what, and the roles they already had', () => {
    expect(readComponentInteraction(pressed)).toEqual({
      interactionId: INTERACTION,
      token: 'a-token',
      type: InteractionType.MessageComponent,
      applicationId: APPLICATION,
      guildId: GUILD,
      channelId: CHANNEL,
      userId: USER,
      roleIds: [ROLE],
      customId: 'proton:rolemenu:colours:red',
      componentType: 2,
      values: [],
      messageId: null,
      messageFlags: null,
    });
  });

  test('reports the message flags, so a handler can tell an ephemeral press from a real message', () => {
    const ephemeral = event(
      'interaction.component',
      interaction(3, { custom_id: 'proton:tickets:opts', component_type: 2 }),
    );

    (ephemeral.payload as Record<string, unknown>).message = {
      id: '700000000000000001',
      flags: 64,
    };

    expect(readComponentInteraction(ephemeral)?.messageFlags).toBe(64);
  });

  test('reads the chosen values of a dropdown', () => {
    const chosen = event(
      'interaction.component',
      interaction(3, {
        custom_id: 'proton:rolemenu:colours:*',
        component_type: 3,
        values: ['red'],
      }),
    );

    expect(readComponentInteraction(chosen)?.values).toEqual(['red']);
  });

  test('surfaces the message the component sits on', () => {
    const payload = interaction(3, { custom_id: 'proton:x:y', component_type: 2 });
    payload.message = { id: '1400000000000000009' };

    expect(readComponentInteraction(event('interaction.component', payload))?.messageId).toBe(
      '1400000000000000009',
    );
  });

  test('falls back to the top-level user in a DM, where there is no member', () => {
    const payload = interaction(3, { custom_id: 'proton:x:y', component_type: 2 });
    payload.member = undefined;
    payload.user = { id: USER };
    payload.guild_id = undefined;

    const read = readComponentInteraction(event('interaction.component', payload));

    expect(read?.userId).toBe(USER);
    expect(read?.roleIds).toBeNull();
    expect(read?.guildId).toBeNull();
  });

  test.each([
    ['a payload that is not an object', 'nope'],
    ['no custom_id', interaction(3, { component_type: 2 })],
    ['no interaction id', { token: 't', data: { custom_id: 'proton:x:y' } }],
    ['nobody to attribute it to', { id: INTERACTION, token: 't', data: { custom_id: 'a' } }],
    ['a modal submission', interaction(5, { custom_id: 'proton:x:y', components: [] })],
  ])('refuses %s', (_label, payload) => {
    expect(readComponentInteraction(event('interaction.component', payload))).toBeNull();
  });
});

describe('readModalInteraction', () => {
  test('flattens the Action Row wrapper Discord has always sent', () => {
    const submitted = event(
      'interaction.modal',
      interaction(5, {
        custom_id: 'proton:ticket:open',
        components: [
          { type: 1, components: [{ type: 4, custom_id: 'subject', value: 'Printer is on fire' }] },
          { type: 1, components: [{ type: 4, custom_id: 'body', value: 'Please help' }] },
        ],
      }),
    );

    expect(readModalInteraction(submitted)?.fields).toEqual({
      subject: 'Printer is on fire',
      body: 'Please help',
    });
  });

  test('flattens the Label wrapper too, which nests one component rather than a list', () => {
    const submitted = event(
      'interaction.modal',
      interaction(5, {
        custom_id: 'proton:ticket:open',
        components: [
          { type: 18, label: 'Subject', component: { type: 4, custom_id: 'subject', value: 'Hi' } },
        ],
      }),
    );

    expect(readModalInteraction(submitted)?.fields).toEqual({ subject: 'Hi' });
  });

  test('reads a modal that mixes both wrappers', () => {
    const submitted = event(
      'interaction.modal',
      interaction(5, {
        custom_id: 'proton:ticket:open',
        components: [
          { type: 1, components: [{ type: 4, custom_id: 'subject', value: 'Hi' }] },
          { type: 18, component: { type: 4, custom_id: 'body', value: 'There' } },
          { type: 10 },
        ],
      }),
    );

    expect(readModalInteraction(submitted)?.fields).toEqual({ subject: 'Hi', body: 'There' });
  });

  test('keeps an empty answer, which is not the same as an unanswered field', () => {
    const submitted = event(
      'interaction.modal',
      interaction(5, {
        custom_id: 'proton:ticket:open',
        components: [{ type: 18, component: { type: 4, custom_id: 'subject', value: '' } }],
      }),
    );

    expect(readModalInteraction(submitted)?.fields).toEqual({ subject: '' });
  });

  test('a select inside a modal lands in values, not fields', () => {
    const submitted = event(
      'interaction.modal',
      interaction(5, {
        custom_id: 'proton:ticket:open',
        components: [
          { type: 18, component: { type: 3, custom_id: 'topic', values: ['billing'] } },
          { type: 18, component: { type: 4, custom_id: 'subject', value: 'Hi' } },
        ],
      }),
    );

    const read = readModalInteraction(submitted);

    expect(read?.values).toEqual({ topic: ['billing'] });
    expect(read?.fields).toEqual({ subject: 'Hi' });
  });

  test('a modal with no components reads as a submission with no answers', () => {
    const submitted = event(
      'interaction.modal',
      interaction(5, { custom_id: 'proton:ticket:open', components: [] }),
    );

    expect(readModalInteraction(submitted)?.fields).toEqual({});
  });

  test.each([
    ['no custom_id', interaction(5, { components: [] })],
    ['a component press', interaction(3, { custom_id: 'proton:x:y', component_type: 2 })],
  ])('refuses %s', (_label, payload) => {
    expect(readModalInteraction(event('interaction.modal', payload))).toBeNull();
  });
});

describe('readAutocompleteInteraction', () => {
  test('names the command and the option being typed into', () => {
    const typing = event(
      'interaction.autocomplete',
      interaction(4, {
        name: 'tag',
        options: [{ name: 'name', type: 3, value: 'wel', focused: true }],
      }),
    );

    const read = readAutocompleteInteraction(typing);

    expect(read?.commandName).toBe('tag');
    expect(read?.focused).toEqual({ name: 'name', type: 3, value: 'wel' });
  });

  test('finds the focused option inside a subcommand, and names the subcommand', () => {
    const typing = event(
      'interaction.autocomplete',
      interaction(4, {
        name: 'tag',
        options: [
          {
            name: 'show',
            type: 1,
            options: [{ name: 'name', type: 3, value: 'wel', focused: true }],
          },
        ],
      }),
    );

    const read = readAutocompleteInteraction(typing);

    expect(read?.subcommand).toBe('show');
    expect(read?.subcommandGroup).toBeNull();
    expect(read?.focused?.name).toBe('name');
    expect(read?.options.map((option) => option.name)).toEqual(['name']);
  });

  test('descends through a subcommand group as well', () => {
    const typing = event(
      'interaction.autocomplete',
      interaction(4, {
        name: 'config',
        options: [
          {
            name: 'levels',
            type: 2,
            options: [
              {
                name: 'set',
                type: 1,
                options: [{ name: 'role', type: 8, value: '70', focused: true }],
              },
            ],
          },
        ],
      }),
    );

    const read = readAutocompleteInteraction(typing);

    expect(read?.subcommandGroup).toBe('levels');
    expect(read?.subcommand).toBe('set');
    expect(read?.focused).toEqual({ name: 'role', type: 8, value: '70' });
  });

  test('a numeric partial value is surfaced as the string the member typed', () => {
    const typing = event(
      'interaction.autocomplete',
      interaction(4, {
        name: 'give',
        options: [{ name: 'amount', type: 4, value: 12, focused: true }],
      }),
    );

    expect(readAutocompleteInteraction(typing)?.focused?.value).toBe('12');
  });

  test('carries the options the member already filled in, so a handler can filter on them', () => {
    const typing = event(
      'interaction.autocomplete',
      interaction(4, {
        name: 'tag',
        options: [
          { name: 'scope', type: 3, value: 'server' },
          { name: 'name', type: 3, value: 'wel', focused: true },
        ],
      }),
    );

    expect(readAutocompleteInteraction(typing)?.options).toEqual([
      { name: 'scope', type: 3, value: 'server' },
      { name: 'name', type: 3, value: 'wel' },
    ]);
  });

  test('reports no focused option rather than guessing at one', () => {
    const typing = event(
      'interaction.autocomplete',
      interaction(4, { name: 'tag', options: [{ name: 'name', type: 3, value: 'wel' }] }),
    );

    expect(readAutocompleteInteraction(typing)?.focused).toBeNull();
  });

  test.each([
    ['a command with no name', interaction(4, { options: [] })],
    ['a component press', interaction(3, { custom_id: 'proton:x:y', component_type: 2 })],
  ])('refuses %s', (_label, payload) => {
    expect(readAutocompleteInteraction(event('interaction.autocomplete', payload))).toBeNull();
  });
});

function recorded(type: EventType, name: DispatchName): ProtonEvent {
  const raw = dispatch(name);
  return {
    id: `evt_${name}`,
    type,
    guildId: typeof raw.d.guild_id === 'string' ? raw.d.guild_id : null,
    occurredAt: 0,
    payload: raw.d,
  };
}

describe('the recorded modal submission', () => {
  const submitted = recorded('interaction.modal', 'interactionCreateModal');

  test('flattens the Label-wrapped Text Input Discord now sends', () => {
    expect(readModalInteraction(submitted)?.fields).toEqual({
      appeal_reason: 'I have read the rules and I will not post invites again.',
    });
  });

  test('carries the custom_id the module will route on, and who submitted it', () => {
    const read = readModalInteraction(submitted);

    expect(read?.customId).toBe('proton:verification:appeal');
    expect(read?.userId).toBe('100000000000000002');
    expect(read?.roleIds).toEqual(['700000000000000001']);
    expect(read?.guildId).toBe('900000000000000001');
    expect(read?.channelId).toBe('500000000000000001');
    expect(read?.token).toBe('modal-interaction-token');
    expect(read?.applicationId).toBe('800000000000000001');
  });

  test('a Label wrapper holding a Text Input contributes no select values', () => {
    expect(readModalInteraction(submitted)?.values).toEqual({});
  });
});

describe('the recorded autocomplete', () => {
  const typing = recorded('interaction.autocomplete', 'interactionCreateAutocomplete');

  test('finds the focused option inside the recorded subcommand', () => {
    const read = readAutocompleteInteraction(typing);

    expect(read?.commandName).toBe('case');
    expect(read?.subcommand).toBe('lookup');
    expect(read?.subcommandGroup).toBeNull();
    expect(read?.focused).toEqual({ name: 'reference', type: 3, value: 'PRO-1' });
  });

  test('unwraps to the subcommand’s own options, not the subcommand itself', () => {
    expect(readAutocompleteInteraction(typing)?.options).toEqual([
      { name: 'reference', type: 3, value: 'PRO-1' },
    ]);
  });

  test('names the interaction the response has to be posted against', () => {
    const read = readAutocompleteInteraction(typing);

    expect(read?.interactionId).toBe('1500000000000000004');
    expect(read?.token).toBe('autocomplete-interaction-token');
  });
});

const readers = [
  ['readComponentInteraction', readComponentInteraction],
  ['readModalInteraction', readModalInteraction],
  ['readAutocompleteInteraction', readAutocompleteInteraction],
] as const;

const recordedInteractions: [DispatchName, EventType][] = [
  ['interactionCreateComponent', 'interaction.component'],
  ['interactionCreateModal', 'interaction.modal'],
  ['interactionCreateAutocomplete', 'interaction.autocomplete'],
  ['interactionCreatePing', 'interaction.component'],
];

describe('a reader only ever answers for its own interaction type', () => {
  const owner: Record<string, DispatchName> = {
    readComponentInteraction: 'interactionCreateComponent',
    readModalInteraction: 'interactionCreateModal',
    readAutocompleteInteraction: 'interactionCreateAutocomplete',
  };

  for (const [readerName, read] of readers) {
    test.each(recordedInteractions)(`${readerName} against %s`, (name, type) => {
      const result = read(recorded(type, name));

      if (owner[readerName] === name) {
        expect(result).not.toBeNull();
        return;
      }

      expect(result).toBeNull();
    });
  }
});

describe('the source interaction type travels with the facts', () => {
  test('a component press is type 3, so a modal may still be opened from it', () => {
    const read = readComponentInteraction(
      recorded('interaction.component', 'interactionCreateComponent'),
    );

    expect(read?.type).toBe(InteractionType.MessageComponent);
  });

  test('a modal submission is type 5 — the type openModal has to refuse', () => {
    const read = readModalInteraction(recorded('interaction.modal', 'interactionCreateModal'));

    expect(read?.type).toBe(InteractionType.ModalSubmit);
  });

  test('an autocomplete is type 4', () => {
    const read = readAutocompleteInteraction(
      recorded('interaction.autocomplete', 'interactionCreateAutocomplete'),
    );

    expect(read?.type).toBe(InteractionType.ApplicationCommandAutocomplete);
  });
});
