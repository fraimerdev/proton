import { describe, expect, test } from 'bun:test';
import { type ModuleManifest, ModuleRegistry } from '@proton/core';
import {
  collectConfigTemplates,
  definePlaceholderSurface,
  lookupFrom,
  MESSAGE_TEMPLATE_FIELDS,
  type ModuleTemplates,
  PLACEHOLDER_LIMITS,
  type PlaceholderDefinitionInput,
  SHARED_PINGS,
  serverDefinitions,
  timeDefinitions,
  userDefinitions,
  placeholderValue as v,
  validateConfigTemplates,
  withAliases,
  withAvailability,
} from '@proton/core/placeholders';
import type { DbHandle } from '@proton/db';
import { z } from 'zod';
import { ModuleConfigError, ModuleConfigService } from '../src/modules/service.ts';
import { assertTemplatesValid } from '../src/modules/templates.ts';

const GUILD = '900000000000000001';
const ACTOR = '100000000000000001';

const ALIASES = new Map([
  ['user.mention', ['user']],
  ['user.global_name', ['username']],
  ['server.name', ['server']],
  ['server.member_count', ['memberCount']],
]);

const ACCOUNT_KEYS = new Set(userDefinitions('user', { member: false }).map(({ key }) => key));

const DEFINITIONS: PlaceholderDefinitionInput[] = [
  ...[
    ...userDefinitions('user', { member: true }),
    ...serverDefinitions(),
    ...timeDefinitions(),
  ].map((definition) => {
    const aliases = ALIASES.get(definition.key);
    const named = aliases === undefined ? definition : withAliases(definition, aliases);
    const memberOnly = definition.key.startsWith('user.') && !ACCOUNT_KEYS.has(definition.key);
    return memberOnly ? withAvailability(named, ['welcome.join']) : named;
  }),
  {
    key: 'user.staff_note',
    label: 'Staff note',
    group: 'Member',
    type: 'text',
    example: v.text('watch them'),
    sensitivity: 'staff_only',
  },
];

function surface(id: string, base: string) {
  return definePlaceholderSurface<null>({
    id,
    module: 'welcome',
    label: id,
    event: id,
    audience: 'public',
    fields: MESSAGE_TEMPLATE_FIELDS.map((spec) => ({ ...spec, path: `${base}.${spec.path}` })),
    definitions: DEFINITIONS,
    build: () => lookupFrom({}),
    samples: [],
    pings: SHARED_PINGS,
  });
}

const JOIN = surface('welcome.join', 'welcomeMessage');
const LEAVE = surface('welcome.leave', 'goodbyeMessage');

const templates: ModuleTemplates = {
  surfaces: { [JOIN.id]: JOIN, [LEAVE.id]: LEAVE },
  collect: (config) => [
    ...collectConfigTemplates(config, JOIN),
    ...collectConfigTemplates(config, LEAVE),
  ],
};

const WELCOME = { name: 'Welcome', templates };

interface Greeting {
  content?: string;
  embeds?: unknown[];
}

function config(welcome: Greeting = {}, goodbye: Greeting = {}, enabled = true) {
  return {
    enabled,
    welcomeMessage: { content: 'Welcome {user}', embeds: [], components: [], v2: [], ...welcome },
    goodbyeMessage: { content: '{username} left', embeds: [], components: [], v2: [], ...goodbye },
  };
}

function refusal(next: unknown, before: unknown): ModuleConfigError {
  try {
    assertTemplatesValid(WELCOME, next, before);
  } catch (error) {
    if (error instanceof ModuleConfigError) return error;
    throw error;
  }
  throw new Error('the save was not refused');
}

function blockingCodes(next: unknown, before?: unknown): string[] {
  return validateConfigTemplates(templates, next, before).blocking.map(
    ({ diagnostic }) => diagnostic.code,
  );
}

const SERVER_ISSUES = /settings were not saved:\s*(.+)$/s;

function serverErrors(message: string): Map<string, string> {
  const errors = new Map<string, string>();
  const body = SERVER_ISSUES.exec(message)?.[1];
  if (body === undefined) return errors;

  for (const part of body.split(';')) {
    const match = /^\s*([A-Za-z0-9_.[\]]+)\s+(.+?)\s*$/.exec(part);
    const path = match?.[1];
    const detail = match?.[2];
    if (path === undefined || detail === undefined || !path.includes('.')) continue;

    if (!errors.has(path)) errors.set(path, detail);
  }

  return errors;
}

describe('assertTemplatesValid', () => {
  test('a changed title with a broken placeholder is refused as invalid_template, naming the path', () => {
    const error = refusal(config({ embeds: [{ title: '{user.nope:upper(}' }] }), config());

    expect(error.code).toBe('invalid_template');
    expect(error.message).toStartWith(
      'Those Welcome settings were not saved: welcomeMessage.embeds.0.title Embed title: ',
    );
  });

  test('an unchanged invalid stored string saves when only the switch changes', () => {
    const before = config({ content: 'Hi {user:shout}' }, {}, true);
    const next = config({ content: 'Hi {user:shout}' }, {}, false);

    expect(() => assertTemplatesValid(WELCOME, next, before)).not.toThrow();
    expect(blockingCodes(next)).toEqual(['unknown_modifier']);
  });

  test('a change that only warns is saved', () => {
    for (const content of ['hello {nobody}', 'a lone { brace', 'Hi {{user}}', 'Hi {user}']) {
      expect(() =>
        assertTemplatesValid(WELCOME, config({ content }), config({ content: 'hello' })),
      ).not.toThrow();
    }
  });

  test('a changed error on the leave message blocks there, naming the path', () => {
    const error = refusal(
      config({}, { content: '{user.nickname}' }),
      config({}, { content: 'hi' }),
    );

    expect(error.message).toStartWith(
      'Those Welcome settings were not saved: goodbyeMessage.content Message text: ',
    );
    expect(error.message).toContain('{user.nickname}');
    expect(() =>
      assertTemplatesValid(WELCOME, config({ content: '{user.nickname}' }), config()),
    ).not.toThrow();
  });

  test('a manifest without templates never refuses anything', () => {
    const cases: Array<[unknown, unknown]> = [
      [config({ content: '{user.nope:upper(}' }), config()],
      [config({ content: '{user.staff_note}' }), undefined],
      [null, undefined],
      ['x', 42],
      [[], { __proto__: null }],
    ];

    for (const [next, before] of cases) {
      expect(() => assertTemplatesValid({ name: 'Ping' }, next, before)).not.toThrow();
    }
  });

  test('the first save compares against the defaults, and no baseline counts every path as changed', () => {
    expect(refusal(config({ content: '{user.staff_note}' }), config()).code).toBe(
      'invalid_template',
    );
    expect(refusal(config({ content: '{user.staff_note}' }), undefined).code).toBe(
      'invalid_template',
    );
  });

  test('every refused field is listed on its own path', () => {
    const error = refusal(
      config(
        { content: '{user.staff_note}', embeds: [{ title: '{user.nope:upper(}' }] },
        { content: '{user.nickname}' },
      ),
      config(),
    );

    expect([...serverErrors(error.message).keys()]).toEqual([
      'welcomeMessage.content',
      'welcomeMessage.embeds.0.title',
      'goodbyeMessage.content',
    ]);
  });
});

describe('restricted data', () => {
  test('a staff-only placeholder written into a public message is refused', () => {
    const next = config({ content: 'Note: {user.staff_note}' });
    const error = refusal(next, config());

    expect(error.message).toContain('welcomeMessage.content Message text: ');
    expect(error.message).toContain('{user.staff_note}');
    expect(blockingCodes(next, config())).toEqual(['restricted']);
  });

  test('with a fallback or a modifier it is still refused', () => {
    for (const content of ['{user.staff_note:fallback("none")}', '{user.staff_note:upper}']) {
      expect(blockingCodes(config({ content }), config())).toContain('restricted');
    }
  });
});

describe('prototype names and injection', () => {
  test('prototype names in a changed template are posted as written and never block', () => {
    for (const content of ['{constructor}', '{__proto__}', '{user.constructor}', '{toString}']) {
      expect(() => assertTemplatesValid(WELCOME, config({ content }), config())).not.toThrow();
    }
  });

  test('a config carrying __proto__ keys is read by its own keys only and pollutes nothing', () => {
    const hostile: unknown = JSON.parse(
      '{"enabled":true,"welcomeMessage":{"__proto__":{"content":"{user.staff_note}"},"content":"Hi {user}","embeds":[{"__proto__":{"title":"{user.staff_note}"}}]},"__proto__":{"goodbyeMessage":{"content":"{user.nickname}"}}}',
    );

    expect(() => assertTemplatesValid(WELCOME, hostile, config())).not.toThrow();
    expect(({} as Record<string, unknown>).content).toBeUndefined();
    expect(({} as Record<string, unknown>).title).toBeUndefined();
    expect(({} as Record<string, unknown>).goodbyeMessage).toBeUndefined();
  });

  test('a ; or a line break inside a quoted argument cannot forge a second field error', () => {
    const content =
      '{user.staff_note:fallback("x; goodbyeMessage.content Message text: forged\nwelcomeMessage.embeds.0.title Embed title: forged")}';
    const error = refusal(config({ content }), config());

    expect([...serverErrors(error.message).keys()]).toEqual(['welcomeMessage.content']);
    expect(error.message).not.toContain(';');
    expect(error.message).not.toMatch(/[\r\n]/);
  });
});

describe('limits', () => {
  test('a changed template past the length limit is refused, and the same stored template is not', () => {
    const long = `Hi {user} ${'x'.repeat(PLACEHOLDER_LIMITS.templateLength)}`;

    expect(blockingCodes(config({ content: long }), config())).toContain('template_too_long');
    expect(refusal(config({ content: long }), config()).message).toContain(
      'welcomeMessage.content Message text: ',
    );
    expect(() =>
      assertTemplatesValid(
        WELCOME,
        config({ content: long }, {}, false),
        config({ content: long }),
      ),
    ).not.toThrow();
  });

  test('one placeholder past the limit is refused, and exactly at the limit is saved', () => {
    const at = '{user}'.repeat(PLACEHOLDER_LIMITS.placeholders);
    const over = '{user}'.repeat(PLACEHOLDER_LIMITS.placeholders + 1);

    expect(() => assertTemplatesValid(WELCOME, config({ content: at }), config())).not.toThrow();
    expect(blockingCodes(config({ content: over }), config())).toContain('too_many_placeholders');
    expect(refusal(config({ content: over }), config()).code).toBe('invalid_template');
  });
});

describe('ModuleConfigService.update', () => {
  const greetingSchema = z.object({ content: z.string().default('') });

  const welcomeSchema = z.object({
    enabled: z.boolean().default(true),
    welcomeMessage: greetingSchema.default({ content: 'Welcome {user}' }),
    goodbyeMessage: greetingSchema.default({ content: '{username} left' }),
  });

  const plainModule: ModuleManifest<typeof welcomeSchema> = {
    id: 'welcome',
    name: 'Welcome',
    category: 'utility',
    configSchema: welcomeSchema,
    defaultConfig: {
      enabled: true,
      welcomeMessage: { content: 'Welcome {user}' },
      goodbyeMessage: { content: '{username} left' },
    },
    schemaVersion: 1,
    requiredIntents: [],
    requiredPermissions: [],
  };

  const welcomeModule: ModuleManifest<typeof welcomeSchema> = { ...plainModule, templates };

  function serviceOver(stored: Record<string, unknown>, manifest: ModuleManifest = welcomeModule) {
    const writes = { transactions: 0 };
    const rows = [{ enabled: true, config: stored, schemaVersion: 1 }];

    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
      transaction: async () => {
        writes.transactions += 1;
      },
    };

    const registry = new ModuleRegistry();
    registry.register(manifest);

    return { service: new ModuleConfigService({ db } as unknown as DbHandle, registry), writes };
  }

  const stored = (content: string) => ({
    enabled: true,
    welcomeMessage: { content },
    goodbyeMessage: { content: 'Bye' },
  });

  test('a changed broken placeholder is refused before anything is written', async () => {
    const { service, writes } = serviceOver(stored('Hi'));

    const error = await service
      .update({
        guildId: GUILD,
        moduleId: 'welcome',
        config: stored('Hi {user.staff_note}'),
        actorId: ACTOR,
        source: 'dashboard',
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(ModuleConfigError);
    expect(error instanceof ModuleConfigError ? error.code : null).toBe('invalid_template');
    expect(error instanceof ModuleConfigError ? error.message : '').toStartWith(
      'Those Welcome settings were not saved: welcomeMessage.content Message text: ',
    );
    expect(writes.transactions).toBe(0);
  });

  test('the sidebar switch saves a server whose stored greeting no longer validates', async () => {
    const { service, writes } = serviceOver(stored('Hi {user:shout}'));

    const { after } = await service.update({
      guildId: GUILD,
      moduleId: 'welcome',
      enabled: false,
      actorId: ACTOR,
      source: 'dashboard',
    });

    expect(after.enabled).toBe(false);
    expect(after.config.welcomeMessage).toEqual({ content: 'Hi {user:shout}' });
    expect(writes.transactions).toBe(1);
  });

  test('a module that declares no templates saves exactly as before', async () => {
    const { service, writes } = serviceOver(stored('Hi'), plainModule);

    await service.update({
      guildId: GUILD,
      moduleId: 'welcome',
      config: stored('Hi {user.staff_note}'),
      actorId: ACTOR,
      source: 'dashboard',
    });

    expect(writes.transactions).toBe(1);
  });
});
