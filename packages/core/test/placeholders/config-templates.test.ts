import { describe, expect, test } from 'bun:test';
import type { ProtonMessage } from '../../src/messages/message.ts';
import {
  aliasFallbacks,
  buildServerValues,
  buildTimeValues,
  buildUserValues,
  collectConfigTemplates,
  definePlaceholderSurface,
  formatTemplateIssues,
  lookupFrom,
  MESSAGE_TEMPLATE_FIELDS,
  type ModuleTemplates,
  type PlaceholderDefinitionInput,
  renderMessageTemplate,
  SAMPLE_MEMBER,
  SAMPLE_NOW,
  SAMPLE_SERVER,
  type SampleMember,
  SHARED_PINGS,
  serverDefinitions,
  type TemplateReport,
  timeDefinitions,
  userDefinitions,
  placeholderValue as v,
  validateConfigTemplates,
  withAliases,
  withAvailability,
} from '../../src/placeholders/index.ts';
import { define } from './harness.ts';

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
  define('user.nope', 'text', v.text('x'), { sensitivity: 'staff_only' }),
];

function surface(id: string, base: string) {
  return definePlaceholderSurface<SampleMember>({
    id,
    module: 'welcome',
    label: id,
    event: id,
    audience: 'public',
    fields: MESSAGE_TEMPLATE_FIELDS.map((spec) => ({ ...spec, path: `${base}.${spec.path}` })),
    definitions: DEFINITIONS,
    build: (facts, env) =>
      aliasFallbacks(
        lookupFrom({
          ...buildUserValues('user', facts.user, facts.member, env.now),
          ...buildServerValues(SAMPLE_SERVER),
          ...buildTimeValues(env.now),
        }),
        { server: v.text('this server'), memberCount: v.integer(0), username: v.text('someone') },
      ),
    samples: [{ id: 'member', label: 'Sample: Fraimer joining Proton HQ', facts: SAMPLE_MEMBER }],
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

function greeting(parts: Partial<ProtonMessage> = {}): ProtonMessage {
  return {
    content: 'Welcome {user}',
    embeds: [],
    components: [],
    mentions: { everyone: false, roles: true, users: true },
    v2: [],
    ...parts,
  };
}

function config(
  welcome: Partial<ProtonMessage> = {},
  goodbye: Partial<ProtonMessage> = {},
  enabled = true,
) {
  return {
    enabled,
    welcomeMessage: greeting(welcome),
    goodbyeMessage: greeting({ content: '{username} left', ...goodbye }),
  };
}

function codesAt(report: TemplateReport, path: string): string[] {
  return (report.byPath.get(path) ?? []).map(({ code }) => code);
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

describe('the changed-only rule', () => {
  test('an unchanged invalid stored string never blocks, so a toggle still saves', () => {
    const before = config({ content: 'Hi {user:shout}' }, {}, true);
    const next = config({ content: 'Hi {user:shout}' }, {}, false);
    const report = validateConfigTemplates(templates, next, before);

    expect(report.blocking).toEqual([]);
    expect(codesAt(report, 'welcomeMessage.content')).toContain('unknown_modifier');
  });

  test('a changed error blocks and names the path', () => {
    const report = validateConfigTemplates(
      templates,
      config({ content: 'Hi {user.nope:upper(}' }),
      config({ content: 'Hi' }),
    );

    expect(report.blocking.map(({ path, label }) => [path, label])).toEqual([
      ['welcomeMessage.content', 'Message text'],
    ]);
    expect(formatTemplateIssues(report)).toStartWith('welcomeMessage.content Message text: ');
  });

  test('a warning-only change is saved', () => {
    const report = validateConfigTemplates(
      templates,
      config({ content: 'hello {nobody}' }),
      config({ content: 'hello' }),
    );

    expect(report.blocking).toEqual([]);
    expect(codesAt(report, 'welcomeMessage.content')).toEqual(['unknown_placeholder']);
  });

  test('a member-only key written into the leave message blocks there', () => {
    const report = validateConfigTemplates(
      templates,
      config({}, { content: '{user.nickname}' }),
      config({}, { content: 'hi' }),
    );

    expect(report.blocking.map(({ path, diagnostic }) => [path, diagnostic.code])).toEqual([
      ['goodbyeMessage.content', 'unavailable'],
    ]);
  });

  test('a path with nothing stored before counts as changed, and so does every path with no baseline', () => {
    const invalid = { embeds: [{ title: '{user.nope}' }] };

    expect(
      validateConfigTemplates(templates, config(invalid), config()).blocking.map(
        ({ path }) => path,
      ),
    ).toEqual(['welcomeMessage.embeds.0.title']);
    expect(
      validateConfigTemplates(templates, config(invalid)).blocking.map(({ path }) => path),
    ).toEqual(['welcomeMessage.embeds.0.title']);
  });

  test('a template moved to another index counts as changed, which blocks only if it is invalid', () => {
    const valid = { title: 'Hi {user}' };
    const invalid = { title: '{user.nope}' };

    const moved = validateConfigTemplates(
      templates,
      config({ embeds: [invalid] }),
      config({ embeds: [valid, invalid] }),
    );
    expect(moved.blocking.map(({ path }) => path)).toEqual(['welcomeMessage.embeds.0.title']);

    const kept = validateConfigTemplates(
      templates,
      config({ embeds: [valid] }),
      config({ embeds: [invalid, valid] }),
    );
    expect(kept.blocking).toEqual([]);
  });
});

describe('diagnostics the surface kit adds', () => {
  test('an unknown placeholder suggests the closest one', () => {
    const report = validateConfigTemplates(templates, config({ content: '{user.nicknam}' }));
    const [diagnostic] = report.byPath.get('welcomeMessage.content') ?? [];

    expect(diagnostic?.code).toBe('unknown_placeholder');
    expect(diagnostic?.message).toEndWith('Did you mean {user.nickname}?');
  });

  test('a mention that would ping warns with the default and the explicit policies, and never blocks', () => {
    const bare = {
      welcomeMessage: { content: 'Hi {user.role_mentions}', embeds: [], components: [], v2: [] },
    };
    const byDefault = validateConfigTemplates(templates, bare, bare);
    expect(codesAt(byDefault, 'welcomeMessage.content')).toContain('may_ping');
    expect(byDefault.blocking).toEqual([]);
    expect(byDefault.byPath.get('welcomeMessage.content')?.at(-1)?.message).toContain(
      'Turn off role pings under Mentions',
    );

    const policy = (roles: boolean, users: boolean, content: string) =>
      codesAt(
        validateConfigTemplates(
          templates,
          config({ content, mentions: { everyone: false, roles, users } }),
        ),
        'welcomeMessage.content',
      );

    expect(policy(false, true, 'Hi {user.role_mentions}')).not.toContain('may_ping');
    expect(policy(true, true, 'Hi {server.owner_mention}')).toContain('may_ping');
    expect(policy(true, false, 'Hi {server.owner_mention}')).not.toContain('may_ping');
    expect(policy(true, true, 'Hi {user.role_mentions:count}')).not.toContain('may_ping');
    expect(policy(true, true, 'Hi {user}')).not.toContain('may_ping');
  });

  test('a legacy alias in a link says it is now written link-safe, unless it cannot go in a link at all', () => {
    const next = config({
      components: [
        {
          kind: 'buttons',
          buttons: [
            { key: 'a', style: 'link', label: 'Go', url: 'https://example.com/{server}' },
            { key: 'b', style: 'link', label: 'Go', url: 'https://example.com/{user}' },
            { key: 'c', style: 'link', label: 'Go', url: 'https://example.com/{memberCount}' },
          ],
        },
      ],
    });
    const report = validateConfigTemplates(templates, next, next);
    const server = report.byPath.get('welcomeMessage.components.0.buttons.0.url') ?? [];

    expect(server).toEqual([
      {
        code: 'legacy_alias_in_url',
        severity: 'info',
        message: '{server} in a link is now written link-safe, so spaces become %20.',
        span: { start: 20, end: 28 },
      },
    ]);
    expect(codesAt(report, 'welcomeMessage.components.0.buttons.1.url')).toEqual([
      'incompatible_field',
    ]);
    expect(codesAt(report, 'welcomeMessage.components.0.buttons.2.url')).toEqual([
      'legacy_alias_in_url',
    ]);
    expect(report.blocking).toEqual([]);
  });

  test('a legacy alias elsewhere is pointed at its full name', () => {
    const report = validateConfigTemplates(templates, config({ content: 'Hi {username}' }));
    const [diagnostic] = report.byPath.get('welcomeMessage.content') ?? [];

    expect(diagnostic?.code).toBe('legacy_alias');
    expect(diagnostic?.severity).toBe('info');
    expect(diagnostic?.message).toContain('{user.global_name}');
  });

  test('doubled braces warn only when they are new', () => {
    const warned = (next: string, before?: string) =>
      codesAt(
        validateConfigTemplates(
          templates,
          config({ content: next }),
          before === undefined ? undefined : config({ content: before }),
        ),
        'welcomeMessage.content',
      ).includes('doubled_brace_literal');

    expect(warned('Hi {{user}}', 'Hi')).toBe(true);
    expect(warned('Hi }} there')).toBe(true);
    expect(warned('Hi {{user}}', 'Hi {{user}}')).toBe(false);
    expect(warned('Hi {{user}}', 'Hi {{x}}')).toBe(false);
    expect(warned('Hi {user}', 'Hi')).toBe(false);
  });

  test('a mention or a date in plain text says what it shows there instead', () => {
    const report = validateConfigTemplates(
      templates,
      config({ embeds: [{ footer: { text: '{user} at {now}' } }] }),
    );

    expect(codesAt(report, 'welcomeMessage.embeds.0.footer.text')).toEqual([
      'legacy_alias',
      'plain_text_value',
      'plain_text_value',
    ]);
  });

  test('restricted data written into a public message blocks', () => {
    const report = validateConfigTemplates(templates, config({ content: '{user.nope}' }), config());

    expect(report.blocking.map(({ diagnostic }) => diagnostic.code)).toEqual(['restricted']);
  });
});

describe('formatTemplateIssues', () => {
  test('round-trips through the dashboard parser, even with ; in a quoted argument', () => {
    const report = validateConfigTemplates(
      templates,
      config({ content: 'Hi {user.nope:fallback("a;b")}' }),
      config(),
    );
    expect(report.blocking).toHaveLength(1);

    const errors = serverErrors(
      `Those Welcome settings were not saved: ${formatTemplateIssues(report)}`,
    );

    expect([...errors.keys()]).toEqual(['welcomeMessage.content']);
    expect(errors.get('welcomeMessage.content')).toStartWith('Message text: ');
    expect(errors.get('welcomeMessage.content')).toContain('a,b');
  });

  test('every issue lands on its own path, and a line break stays on one line', () => {
    const report = validateConfigTemplates(
      templates,
      config({ content: '{user.nope:fallback("a\nb")}', embeds: [{ title: '{user.nope}' }] }),
      config(),
    );
    const errors = serverErrors(
      `Those Welcome settings were not saved: ${formatTemplateIssues(report)}`,
    );

    expect([...errors.keys()]).toEqual(['welcomeMessage.content', 'welcomeMessage.embeds.0.title']);
    expect(errors.get('welcomeMessage.content')).toContain('a b');
  });
});

describe('tolerance and leniency', () => {
  test('any stored shape is collected without throwing', () => {
    for (const garbage of [
      null,
      undefined,
      'x',
      42,
      [],
      { welcomeMessage: 5 },
      { welcomeMessage: { content: 7, embeds: 'no', components: [null], v2: {} } },
    ]) {
      expect(validateConfigTemplates(templates, garbage, garbage).blocking).toEqual([]);
    }
  });

  test('a site on a surface the module does not declare is skipped', () => {
    const report = validateConfigTemplates(
      { surfaces: {}, collect: templates.collect },
      config({ content: '{user.nope}' }),
    );

    expect(report.byPath.size).toBe(0);
    expect(report.blocking).toEqual([]);
  });

  test('a stored template that newly errors still renders exactly as the engine does', () => {
    const result = renderMessageTemplate(
      greeting({ content: 'Hi {user:shout}' }),
      JOIN,
      JOIN.build(SAMPLE_MEMBER, { now: SAMPLE_NOW }),
      { now: SAMPLE_NOW, basePath: 'welcomeMessage' },
    );

    expect(result.ok && result.message.content).toBe(`Hi <@${SAMPLE_MEMBER.user.id}>`);
    expect(result.diagnostics.map(({ code }) => code)).toEqual(['unknown_modifier']);
  });
});
