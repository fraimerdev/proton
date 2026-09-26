import { describe, expect, test } from 'bun:test';
import {
  ChannelType,
  InteractionContextType,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  ApplicationCommandOptionType as T,
} from 'discord-api-types/v10';
import {
  applyCommandSettings,
  commandSize,
  fixedSize,
  normalizeCommandInput,
  validateCommand,
} from '../../src/commands/effective.ts';
import { commandFields } from '../../src/commands/fields.ts';
import { type CommandSettings, commandSettingsSchema } from '../../src/commands/settings.ts';

type ChatData = RESTPostAPIChatInputApplicationCommandsJSONBody;

function settings(overrides: Partial<CommandSettings> = {}): CommandSettings {
  return { ...commandSettingsSchema.parse({}), ...overrides };
}

function ticket(): ChatData {
  return {
    name: 'ticket',
    name_localizations: { fr: 'billet' },
    description: 'Manage tickets.',
    description_localizations: { fr: 'Gérer les billets.' },
    default_member_permissions: '8192',
    contexts: [InteractionContextType.Guild],
    nsfw: false,
    options: [
      {
        type: T.Subcommand,
        name: 'add',
        description: 'Add someone to this ticket.',
        description_localizations: { fr: 'Ajouter quelqu’un.' },
        options: [
          {
            type: T.User,
            name: 'user',
            name_localizations: { fr: 'membre' },
            description: 'Who to add.',
            description_localizations: { fr: 'Qui ajouter.' },
            required: true,
          },
        ],
      },
      {
        type: T.SubcommandGroup,
        name: 'blacklist',
        description: 'Keep people from opening tickets.',
        options: [
          {
            type: T.Subcommand,
            name: 'add',
            description: 'Blacklist someone.',
            options: [
              {
                type: T.User,
                name: 'user',
                description: 'Who to blacklist.',
                description_localizations: { fr: 'Qui bannir.' },
                required: true,
              },
              {
                type: T.String,
                name: 'reason',
                description: 'Why.',
                max_length: 512,
                autocomplete: true,
              },
            ],
          },
        ],
      },
      {
        type: T.Subcommand,
        name: 'priority',
        description: 'Set the priority.',
        options: [
          {
            type: T.String,
            name: 'level',
            description: 'How urgent.',
            required: true,
            choices: [
              { name: 'Low', name_localizations: { fr: 'Basse' }, value: 'low' },
              { name: 'Urgent', value: 'urgent' },
            ],
          },
          {
            type: T.Integer,
            name: 'days',
            description: 'For how long.',
            min_value: 1,
            max_value: 365,
            choices: [{ name: 'A week', value: 7 }],
          },
          {
            type: T.Channel,
            name: 'where',
            description: 'Which channel.',
            channel_types: [ChannelType.GuildText],
          },
        ],
      },
    ],
  };
}

describe('applyCommandSettings', () => {
  test('with no overrides the effective definition is the code definition', () => {
    expect(applyCommandSettings(ticket(), settings())).toEqual(ticket());
  });

  test('renames the command and drops the name localizations that described the old name', () => {
    const applied = applyCommandSettings(ticket(), settings({ name: 'support' }));

    expect(applied.name).toBe('support');
    expect(applied.name_localizations).toBeUndefined();
    expect(applied.description_localizations).toEqual({ fr: 'Gérer les billets.' });
  });

  test('replaces the description and drops only its own localizations', () => {
    const applied = applyCommandSettings(ticket(), settings({ description: 'Get help.' }));

    expect(applied.description).toBe('Get help.');
    expect(applied.description_localizations).toBeUndefined();
    expect(applied.name_localizations).toEqual({ fr: 'billet' });
  });

  test('an option override reaches that path only: /ticket add and /ticket blacklist add stay independent', () => {
    const applied = applyCommandSettings(
      ticket(),
      settings({ optionDescriptions: { 'add.user': 'The member to bring in.' } }),
    );
    const code = ticket();

    const add = applied.options?.[0] as { options: Array<Record<string, unknown>> };
    expect(add.options[0]?.description).toBe('The member to bring in.');
    expect(add.options[0]?.description_localizations).toBeUndefined();
    expect(add.options[0]?.name).toBe('user');
    expect(add.options[0]?.name_localizations).toEqual({ fr: 'membre' });

    expect(applied.options?.[1]).toEqual(code.options?.[1]);
    expect(applied.options?.[2]).toEqual(code.options?.[2]);
  });

  test('subcommands and groups take their own description overrides', () => {
    const applied = applyCommandSettings(
      ticket(),
      settings({
        optionDescriptions: {
          add: 'Bring someone in.',
          blacklist: 'Who may not open tickets.',
          'blacklist.add': 'Keep someone out.',
        },
      }),
    );

    const [add, blacklist] = applied.options as Array<{
      description: string;
      description_localizations?: unknown;
      options?: Array<{ description: string }>;
    }>;

    expect(add?.description).toBe('Bring someone in.');
    expect(add?.description_localizations).toBeUndefined();
    expect(blacklist?.description).toBe('Who may not open tickets.');
    expect(blacklist?.options?.[0]?.description).toBe('Keep someone out.');
  });

  test('a blank override inherits Proton’s default', () => {
    const applied = applyCommandSettings(
      ticket(),
      settings({ name: '', description: '   ', optionDescriptions: { 'add.user': ' ' } }),
    );

    expect(applied).toEqual(ticket());
  });

  test('an override equal to the default changes nothing, localizations included', () => {
    const applied = applyCommandSettings(
      ticket(),
      settings({
        name: 'ticket',
        description: 'Manage tickets.',
        optionDescriptions: { 'add.user': 'Who to add.' },
      }),
    );

    expect(applied).toEqual(ticket());
  });

  test('an override for a path the code no longer has is ignored safely', () => {
    const applied = applyCommandSettings(
      ticket(),
      settings({ optionDescriptions: { 'remove.user': 'Gone.', 'add.user.extra': 'Nope.' } }),
    );

    expect(applied).toEqual(ticket());
  });

  test('changes nothing an admin cannot edit', () => {
    const applied = applyCommandSettings(
      ticket(),
      settings({
        name: 'support',
        description: 'Get help.',
        optionDescriptions: {
          'priority.level': 'Pick one.',
          'priority.days': 'Pick a length.',
          'priority.where': 'Pick a channel.',
          'blacklist.add.reason': 'Say why.',
        },
      }),
    );
    const code = ticket();

    expect(applied.default_member_permissions).toBe('8192');
    expect(applied.contexts).toEqual([InteractionContextType.Guild]);
    expect(applied.nsfw).toBe(false);

    const priority = applied.options?.[2] as { options: Array<Record<string, unknown>> };
    const codePriority = code.options?.[2] as { options: Array<Record<string, unknown>> };
    for (const [index, option] of priority.options.entries()) {
      const { description: _d, ...rest } = option;
      const {
        description: _c,
        description_localizations: _l,
        ...codeRest
      } = codePriority.options[index] ?? {};
      expect(rest).toEqual(codeRest);
    }

    const blacklist = applied.options?.[1] as { options: Array<{ options: unknown[] }> };
    const reason = blacklist.options[0]?.options[1];
    expect(reason).toEqual({
      type: T.String,
      name: 'reason',
      description: 'Say why.',
      max_length: 512,
      autocomplete: true,
    });
  });

  test('never touches the code definition it was given', () => {
    const code = ticket();

    applyCommandSettings(
      code,
      settings({ name: 'support', optionDescriptions: { 'add.user': 'Someone.' } }),
    );

    expect(code).toEqual(ticket());
  });

  test('an override keyed by an inherited property name is not read from the prototype', () => {
    const data: ChatData = {
      name: 'x',
      description: 'X.',
      options: [{ type: T.String, name: 'constructor', description: 'Kept.' }],
    };

    expect(applyCommandSettings(data, settings())).toEqual(data);
  });
});

describe('validateCommand', () => {
  test('a well-formed command has no issues', () => {
    expect(validateCommand(ticket())).toEqual([]);
  });

  test('an uppercase name is refused', () => {
    expect(validateCommand({ ...ticket(), name: 'Ticket' })).toEqual([
      { path: 'name', message: 'Command names must be lowercase.' },
    ]);
  });

  test('a name with a space or a symbol is refused and says what is allowed', () => {
    for (const name of ['my ticket', 'ticket!', 'tick.et']) {
      expect(validateCommand({ ...ticket(), name })).toEqual([
        {
          path: 'name',
          message: 'Command names can only use letters, numbers, - and _, with no spaces.',
        },
      ]);
    }
  });

  test('an empty name is refused', () => {
    expect(validateCommand({ ...ticket(), name: '' })).toEqual([
      { path: 'name', message: 'Give the command a name.' },
    ]);
  });

  test('a name over 32 characters names the limit and its own length', () => {
    expect(validateCommand({ ...ticket(), name: 'a'.repeat(33) })).toEqual([
      { path: 'name', message: 'Command names can be at most 32 characters (this one is 33).' },
    ]);
  });

  test('counts a name in code points, so 32 astral letters pass', () => {
    expect(validateCommand({ ...ticket(), name: '𝒶'.repeat(32) })).toEqual([]);
    expect(validateCommand({ ...ticket(), name: '𝒶'.repeat(33) })[0]?.message).toContain(
      '(this one is 33)',
    );
  });

  test('accepts the scripts Discord allows beyond letters and numbers', () => {
    for (const name of ['ʼban', 'पकड़', 'ห้าม', 'модерация']) {
      expect(validateCommand({ ...ticket(), name })).toEqual([]);
    }
  });

  test('a description over 100 characters names the limit and its own length', () => {
    expect(validateCommand({ ...ticket(), description: 'x'.repeat(112) })).toEqual([
      {
        path: 'description',
        message: 'Descriptions can be at most 100 characters (this one is 112).',
      },
    ]);
  });

  test('an empty description is refused, because Discord requires one', () => {
    expect(validateCommand({ ...ticket(), description: ' ' })).toEqual([
      { path: 'description', message: 'Discord needs a description here.' },
    ]);
  });

  test('counts a description in code points', () => {
    expect(validateCommand({ ...ticket(), description: '🔨'.repeat(100) })).toEqual([]);
  });

  test('an option, subcommand or group description is checked at its own path', () => {
    const applied = applyCommandSettings(
      ticket(),
      settings({
        optionDescriptions: {
          'blacklist.add.reason': 'y'.repeat(101),
          blacklist: 'z'.repeat(150),
        },
      }),
    );

    expect(validateCommand(applied)).toEqual([
      {
        path: 'options.blacklist',
        message: 'Descriptions can be at most 100 characters (this one is 150).',
      },
      {
        path: 'options.blacklist.add.reason',
        message: 'Descriptions can be at most 100 characters (this one is 101).',
      },
    ]);
  });

  test('a definition over 8000 characters gets a size issue that names both numbers', () => {
    const options = Array.from({ length: 25 }, (_unused, sub) => ({
      type: T.Subcommand as const,
      name: `s${sub}`,
      description: 'd'.repeat(100),
      options: Array.from({ length: 4 }, (_none, index) => ({
        type: T.String as const,
        name: `o${index}`,
        description: 'e'.repeat(100),
      })),
    }));
    const big: ChatData = { name: 'big', description: 'b'.repeat(100), options };
    const size = commandSize(big);

    expect(size).toBeGreaterThan(8000);
    expect(validateCommand(big)).toEqual([
      {
        path: 'size',
        message:
          'Discord allows 8000 characters per command across its name, descriptions, option ' +
          `names and choices, and this one has ${size}. Shorten some descriptions.`,
      },
    ]);
  });

  test('the size limit counts the longest localization of a field, as Discord does', () => {
    const near: ChatData = {
      name: 'near',
      description: 'x',
      options: Array.from({ length: 25 }, (_unused, sub) => ({
        type: T.Subcommand as const,
        name: `s${String(sub).padStart(2, '0')}`,
        description: 'd'.repeat(100),
        options: [
          { type: T.String as const, name: 'option0', description: 'e'.repeat(100) },
          { type: T.String as const, name: 'option1', description: 'e'.repeat(100) },
        ],
      })),
    };

    expect(commandSize(near)).toBe(7930);
    expect(validateCommand(near)).toEqual([]);

    const localized: ChatData = { ...near, description_localizations: { fr: 'l'.repeat(100) } };
    expect(commandSize(localized)).toBe(8029);
    expect(validateCommand(localized).map((issue) => issue.path)).toEqual(['size']);
  });
});

describe('commandSize and fixedSize', () => {
  test('count every name, description, choice name and stringified choice value', () => {
    const data: ChatData = {
      name: 'rate',
      description: 'Rate it.',
      options: [
        {
          type: T.Integer,
          name: 'stars',
          description: 'How many.',
          choices: [
            { name: 'One', value: 1 },
            { name: 'Ten', value: 10 },
          ],
        },
      ],
    };

    expect(commandSize(data)).toBe(4 + 8 + 5 + 9 + (3 + 1) + (3 + 2));
    expect(fixedSize(data)).toBe(5 + (3 + 1) + (3 + 2));
  });

  test('a localized field counts only its longest variant', () => {
    const data: ChatData = {
      name: 'ban',
      name_localizations: { fr: 'bannir', de: 'sperren-lang' },
      description: 'Ban.',
      description_localizations: { fr: 'Bannir.', de: null },
      options: [
        {
          type: T.String,
          name: 'why',
          name_localizations: { fr: 'pourquoi' },
          description: 'Why.',
          choices: [{ name: 'Spam', name_localizations: { fr: 'Pourriel' }, value: 'spam' }],
        },
      ],
    };

    expect(commandSize(data)).toBe(12 + 7 + 8 + 4 + 8 + 4);
    expect(fixedSize(data)).toBe(8 + 8 + 4);
  });

  test('fixedSize is everything but the command’s own name and every description', () => {
    const plain = JSON.parse(
      JSON.stringify(ticket(), (key, value) =>
        key.endsWith('_localizations') ? undefined : value,
      ),
    ) as ChatData;
    const descriptions = (list: ReturnType<typeof commandFields>): number =>
      list.reduce((sum, field) => sum + field.description.length + descriptions(field.children), 0);

    expect(commandSize(plain)).toBe(
      fixedSize(plain) +
        plain.name.length +
        plain.description.length +
        descriptions(commandFields(plain)),
    );
  });
});

describe('normalizeCommandInput', () => {
  const blank = { name: null, description: null, optionDescriptions: {}, privateReply: null };

  test('trims, strips one leading slash and lowercases the name', () => {
    const normalized = normalizeCommandInput(ticket(), settings(), {
      ...blank,
      name: '  /Support ',
    });

    expect(normalized.name).toBe('support');
  });

  test('strips only one slash, so a doubled one still reaches validation', () => {
    expect(normalizeCommandInput(ticket(), settings(), { ...blank, name: '//x' }).name).toBe('/x');
  });

  test('blank text and the code default both mean inherit', () => {
    for (const name of ['', '   ', '/', 'ticket', '/TICKET']) {
      expect(normalizeCommandInput(ticket(), settings(), { ...blank, name }).name).toBeNull();
    }
    for (const description of ['', '  ', 'Manage tickets.', ' Manage tickets. ']) {
      expect(
        normalizeCommandInput(ticket(), settings(), { ...blank, description }).description,
      ).toBeNull();
    }
  });

  test('keeps a real description override, trimmed', () => {
    expect(
      normalizeCommandInput(ticket(), settings(), { ...blank, description: '  Get help.  ' })
        .description,
    ).toBe('Get help.');
  });

  test('takes option descriptions for the paths the command has, dropping blanks and defaults', () => {
    const normalized = normalizeCommandInput(ticket(), settings(), {
      ...blank,
      optionDescriptions: {
        'add.user': ' The member to bring in. ',
        'blacklist.add.user': 'Who to blacklist.',
        'blacklist.add.reason': '   ',
        blacklist: 'Who may not open tickets.',
      },
    });

    expect(normalized.optionDescriptions).toEqual({
      'add.user': 'The member to bring in.',
      blacklist: 'Who may not open tickets.',
    });
  });

  test('a current path left out of the submission is cleared', () => {
    const stored = settings({ optionDescriptions: { 'add.user': 'Someone.' } });

    expect(normalizeCommandInput(ticket(), stored, blank).optionDescriptions).toEqual({});
  });

  test('keeps stored overrides for paths the code no longer has, so a rollback finds them', () => {
    const stored = settings({
      optionDescriptions: { 'remove.user': 'Who to take out.', 'add.user': 'Someone.' },
    });

    expect(
      normalizeCommandInput(ticket(), stored, {
        ...blank,
        description: 'Get help.',
        optionDescriptions: { 'remove.user': 'Changed.', 'close.reason': 'New.' },
      }).optionDescriptions,
    ).toEqual({ 'remove.user': 'Who to take out.' });
  });

  test('a reply preference alone is not a reset, so the removed paths are kept', () => {
    const stored = settings({ optionDescriptions: { 'remove.user': 'Who to take out.' } });

    expect(
      normalizeCommandInput(ticket(), stored, { ...blank, privateReply: false }),
    ).toMatchObject({ optionDescriptions: { 'remove.user': 'Who to take out.' } });
  });

  test('an all-blank save is a reset: the removed paths go with everything else', () => {
    const stored = settings({
      enabled: false,
      name: 'support',
      description: 'Get help.',
      optionDescriptions: { 'remove.user': 'Who to take out.', 'add.user': 'Someone.' },
      privateReply: true,
    });

    for (const input of [
      blank,
      { ...blank, name: 'ticket', description: 'Manage tickets.' },
      { ...blank, optionDescriptions: { 'add.user': 'Who to add.', 'remove.user': 'Changed.' } },
    ]) {
      expect(normalizeCommandInput(ticket(), stored, input)).toEqual({
        enabled: false,
        name: null,
        description: null,
        optionDescriptions: {},
        privateReply: null,
      });
    }
  });

  test('passes the reply preference through exactly as submitted', () => {
    for (const privateReply of [true, false, null]) {
      expect(
        normalizeCommandInput(ticket(), settings({ privateReply: true }), {
          ...blank,
          privateReply,
        }).privateReply,
      ).toBe(privateReply);
    }
  });

  test('never takes the switch from the input', () => {
    const input = { ...blank, name: 'support', enabled: true };

    expect(normalizeCommandInput(ticket(), settings({ enabled: false }), input).enabled).toBe(
      false,
    );
    expect(normalizeCommandInput(ticket(), settings({ enabled: true }), blank).enabled).toBe(true);
  });
});
