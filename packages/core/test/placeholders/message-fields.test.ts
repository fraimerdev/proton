import { describe, expect, test } from 'bun:test';
import type { ProtonMessage } from '../../src/messages/message.ts';
import {
  aliasFallbacks,
  buildServerValues,
  buildTimeValues,
  buildUserValues,
  collectMessageSites,
  definePlaceholderSurface,
  lookupFrom,
  MESSAGE_TEMPLATE_FIELDS,
  type MemberFacts,
  type MessageRender,
  type PlaceholderDefinitionInput,
  type PlaceholderLookup,
  REPLY_ACTION_FIELDS,
  renderMessageTemplate,
  SAMPLE_NOW,
  type ServerFacts,
  SHARED_PINGS,
  serverDefinitions,
  timeDefinitions,
  type UserFacts,
  userDefinitions,
  placeholderValue as v,
  withAliases,
} from '../../src/placeholders/index.ts';
import { define } from './harness.ts';

const MEMBER_ID = '100000000000000010';
const GUILD_ID = '100000000000000001';
const ROLE_ID = '100000000000000020';

interface JoinFacts {
  user: UserFacts;
  member: MemberFacts;
  server: ServerFacts | null;
}

const ALIASES = new Map([
  ['user.mention', ['user']],
  ['user.global_name', ['username']],
  ['server.name', ['server']],
  ['server.member_count', ['memberCount']],
]);

const DEFINITIONS: PlaceholderDefinitionInput[] = [
  ...[
    ...userDefinitions('user', { member: true }),
    ...serverDefinitions(),
    ...timeDefinitions(),
  ].map((definition) => {
    const aliases = ALIASES.get(definition.key);
    return aliases === undefined ? definition : withAliases(definition, aliases);
  }),
  define('secret.note', 'text', v.text('x'), { sensitivity: 'member_private' }),
];

const JOIN = definePlaceholderSurface<JoinFacts>({
  id: 'test.join',
  module: 'test',
  label: 'Test greeting',
  event: 'test.join',
  audience: 'public',
  fields: MESSAGE_TEMPLATE_FIELDS.map((spec) => ({ ...spec, path: `welcomeMessage.${spec.path}` })),
  definitions: DEFINITIONS,
  build: (facts, env) =>
    aliasFallbacks(
      lookupFrom({
        ...buildUserValues('user', facts.user, facts.member, env.now),
        ...buildServerValues(facts.server),
        ...buildTimeValues(env.now),
      }),
      { server: v.text('this server'), memberCount: v.integer(0), username: v.text('someone') },
    ),
  samples: [],
  pings: SHARED_PINGS,
});

function facts(
  overrides: {
    user?: Partial<UserFacts>;
    member?: Partial<MemberFacts>;
    server?: ServerFacts | null;
  } = {},
): JoinFacts {
  return {
    user: {
      id: MEMBER_ID,
      username: 'fraimer',
      globalName: 'Fraimer',
      avatarHash: null,
      ...overrides.user,
    },
    member: {
      nick: null,
      joinedAt: '2026-09-14T09:00:00.000Z',
      premiumSince: null,
      roleIds: [],
      ...overrides.member,
    },
    server:
      overrides.server === undefined
        ? { id: GUILD_ID, name: 'Proton HQ', memberCount: 42, iconHash: null }
        : overrides.server,
  };
}

function message(parts: Partial<ProtonMessage> = {}): ProtonMessage {
  return {
    embeds: [],
    components: [],
    mentions: { everyone: false, roles: true, users: true },
    v2: [],
    ...parts,
  };
}

function render(
  input: ProtonMessage,
  given: JoinFacts = facts(),
  lookup?: PlaceholderLookup,
): MessageRender<ProtonMessage> {
  return renderMessageTemplate(input, JOIN, lookup ?? JOIN.build(given, { now: SAMPLE_NOW }), {
    now: SAMPLE_NOW,
    basePath: 'welcomeMessage',
  });
}

function sent(result: MessageRender<ProtonMessage>): ProtonMessage {
  if (!result.ok) throw new Error(result.humanReason);
  return result.message;
}

function refusal(result: MessageRender<ProtonMessage>): string {
  if (result.ok) throw new Error('the message rendered, but it should have been refused');
  return result.humanReason;
}

const READABLE_NOW = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
}).format(SAMPLE_NOW);

describe('renderMessageTemplate', () => {
  test('fills in every allowlisted field and never touches structure', () => {
    const output = sent(
      render(
        message({
          content: 'Welcome {user} to {server}, member #{memberCount}',
          embeds: [
            {
              title: 'Hi {username}',
              description: '**{server}**',
              url: 'https://example.com/{server}',
              color: 5,
              author: { name: '{user}', iconUrl: 'https://cdn.example.com/{server}.png' },
              footer: { text: '{now}' },
              fields: [{ name: '{server}', value: '{memberCount}', inline: true }],
            },
          ],
          components: [
            {
              kind: 'buttons',
              buttons: [
                {
                  key: 'user',
                  style: 'primary',
                  label: '{username}',
                  emoji: { name: '{server}' },
                  action: { kind: 'role', mode: 'toggle', roleId: ROLE_ID },
                },
                {
                  key: 'server',
                  style: 'link',
                  label: 'Visit',
                  url: 'https://example.com/{server}',
                },
              ],
            },
          ],
        }),
      ),
    );

    expect(output.content).toBe(`Welcome <@${MEMBER_ID}> to Proton HQ, member #42`);
    expect(output.embeds).toEqual([
      {
        title: 'Hi Fraimer',
        description: '**Proton HQ**',
        url: 'https://example.com/Proton%20HQ',
        color: 5,
        author: { name: 'Fraimer', iconUrl: 'https://cdn.example.com/Proton%20HQ.png' },
        footer: { text: READABLE_NOW },
        fields: [{ name: 'Proton HQ', value: '42', inline: true }],
      },
    ]);
    expect(output.components).toEqual([
      {
        kind: 'buttons',
        buttons: [
          {
            key: 'user',
            style: 'primary',
            label: 'Fraimer',
            emoji: { name: '{server}' },
            action: { kind: 'role', mode: 'toggle', roleId: ROLE_ID },
          },
          { key: 'server', style: 'link', label: 'Visit', url: 'https://example.com/Proton%20HQ' },
        ],
      },
    ]);
    expect(output.mentions).toEqual({ everyone: false, roles: true, users: true });
  });

  test('a date is a Discord timestamp in message text and a readable date in a footer', () => {
    const output = sent(
      render(message({ content: '{now}', embeds: [{ footer: { text: '{now}' } }] })),
    );

    expect(output.content).toBe(`<t:${SAMPLE_NOW / 1000}:f>`);
    expect(output.embeds[0]?.footer?.text).toMatch(/^Sep 14, 2026, 9:00\sAM$/u);
  });

  test('a mention alias in a link renders nothing there and says why', () => {
    const result = render(
      message({
        components: [
          {
            kind: 'buttons',
            buttons: [{ key: 'go', style: 'link', label: 'Go', url: 'https://example.com/{user}' }],
          },
        ],
      }),
    );

    const output = sent(result);
    const [row] = output.components;
    expect(row?.kind === 'buttons' ? row.buttons[0]?.url : undefined).toBe('https://example.com/');
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'incompatible_field',
        path: 'welcomeMessage.components.0.buttons.0.url',
      }),
    );
  });

  test('a value cannot mass-mention in message text, and plain text is left as it is', () => {
    const output = sent(
      render(
        message({
          content: '{username}',
          components: [
            {
              kind: 'buttons',
              buttons: [
                {
                  key: 'a',
                  style: 'primary',
                  label: '{username}',
                  action: { kind: 'role', mode: 'add', roleId: ROLE_ID },
                },
              ],
            },
          ],
        }),
        facts({ user: { globalName: '@everyone' } }),
      ),
    );

    expect(output.content).toBe('@​everyone');
    const [row] = output.components;
    expect(row?.kind === 'buttons' ? row.buttons[0]?.label : undefined).toBe('@everyone');
  });

  test('a member-controlled value is escaped and never expanded again', () => {
    const hostile = `{server} <@&${ROLE_ID}> **x**`;
    const output = sent(
      render(message({ content: '{user.global_name}' }), facts({ user: { globalName: hostile } })),
    );

    expect(output.content).toBe(`{server} \\<@&${ROLE_ID}\\> \\*\\*x\\*\\*`);
    expect(output.content).not.toMatch(/(?<!\\)<@&/);
    expect(output.content).not.toContain('Proton HQ');
  });

  test('prototype names are posted as written', () => {
    const template = '{constructor} {__proto__} {user.constructor} {toString}';
    const result = render(message({ content: template }));

    expect(sent(result).content).toBe(template);
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      'forbidden_key',
      'forbidden_key',
      'forbidden_key',
      'unknown_placeholder',
    ]);
  });

  test('legacy fallbacks fill in when the server was never seen', () => {
    const output = sent(
      render(
        message({ content: '{username} joined {server} ({memberCount}) [{server.name}]' }),
        facts({ user: { globalName: null, username: null }, server: null }),
      ),
    );

    expect(output.content).toBe('someone joined this server (0) []');
  });

  test('restricted data is never looked up', () => {
    let asked = 0;
    const inner = JOIN.build(facts(), { now: SAMPLE_NOW });
    const result = render(message({ content: '[{secret.note}]' }), facts(), (request) => {
      if (request.canonical === 'secret.note') asked += 1;
      return inner(request);
    });

    expect(sent(result).content).toBe('[]');
    expect(result.diagnostics.map(({ code }) => code)).toEqual(['restricted']);
    expect(asked).toBe(0);
  });

  test('an optional link that renders empty is dropped from the embed', () => {
    const output = sent(
      render(message({ embeds: [{ title: 'Hi', thumbnailUrl: '{server.icon_url}' }] })),
    );

    expect(output.embeds[0]).toEqual({ title: 'Hi' });
  });

  test('a link button whose link renders empty is refused, naming the path and its tokens', () => {
    const reason = refusal(
      render(
        message({
          components: [
            {
              kind: 'buttons',
              buttons: [{ key: 'go', style: 'link', label: 'Go', url: '{server.icon_url}' }],
            },
          ],
        }),
      ),
    );

    expect(reason).toContain('welcomeMessage.components.0.buttons.0.url (Button link)');
    expect(reason).toContain('It uses {server.icon_url}.');
  });

  test('a link that does not come out as http or https refuses the message', () => {
    const reason = refusal(render(message({ embeds: [{ title: 'Hi', imageUrl: '{server}' }] })));

    expect(reason).toContain('welcomeMessage.embeds.0.imageUrl (Embed image)');
    expect(reason).toContain('http or https');
  });

  test('text Discord refuses empty is refused once rendered', () => {
    const blankNick = facts({ member: { nick: null } });

    expect(
      refusal(render(message({ v2: [{ kind: 'text', content: '{user.nickname}' }] }), blankNick)),
    ).toContain('welcomeMessage.v2.0.content (Text)');
    expect(
      refusal(render(message({ embeds: [{ description: '{user.nickname}' }] }), blankNick)),
    ).toContain('welcomeMessage.embeds.0 (Embed)');
    expect(
      refusal(
        render(
          message({ embeds: [{ fields: [{ name: '{user.nickname}', value: 'x' }] }] }),
          blankNick,
        ),
      ),
    ).toContain('welcomeMessage.embeds.0.fields.0.name (Embed field name)');
  });

  test('renders a components-v2 layout inside containers and sections', () => {
    const output = sent(
      render(
        message({
          v2: [
            {
              kind: 'container',
              children: [
                {
                  kind: 'section',
                  text: ['Hi {user}', '{server}'],
                  accessory: {
                    kind: 'thumbnail',
                    url: '{user.avatar_url}',
                    description: '{username}',
                  },
                },
                {
                  kind: 'gallery',
                  items: [{ url: 'https://example.com/{server}.png', description: '{user}' }],
                },
                {
                  kind: 'row',
                  row: {
                    kind: 'buttons',
                    buttons: [
                      { key: 'go', style: 'link', label: '{username}', url: 'https://example.com' },
                    ],
                  },
                },
              ],
            },
          ],
        }),
      ),
    );

    const avatar = `https://cdn.discordapp.com/embed/avatars/${(BigInt(MEMBER_ID) >> 22n) % 6n}.png`;

    expect(output.v2).toEqual([
      {
        kind: 'container',
        children: [
          {
            kind: 'section',
            text: [`Hi <@${MEMBER_ID}>`, 'Proton HQ'],
            accessory: { kind: 'thumbnail', url: avatar, description: 'Fraimer' },
          },
          {
            kind: 'gallery',
            items: [{ url: 'https://example.com/Proton%20HQ.png', description: 'Fraimer' }],
          },
          {
            kind: 'row',
            row: {
              kind: 'buttons',
              buttons: [{ key: 'go', style: 'link', label: 'Fraimer', url: 'https://example.com' }],
            },
          },
        ],
      },
    ]);
  });

  test('clips a value past Discord’s limit and reports it on the path', () => {
    const result = render(
      message({ embeds: [{ title: '{server}' }] }),
      facts({ server: { id: GUILD_ID, name: 'P'.repeat(300) } }),
    );

    expect(sent(result).embeds[0]?.title).toBe('P'.repeat(256));
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'output_truncated', path: 'welcomeMessage.embeds.0.title' }),
    );
  });

  test('never renders a reply action, which is filled in when it is pressed', () => {
    const output = sent(
      render(
        message({
          content: 'x',
          components: [
            {
              kind: 'buttons',
              buttons: [
                {
                  key: 'hi',
                  style: 'primary',
                  label: 'Hi',
                  action: { kind: 'reply', content: '{server}', ephemeral: true },
                },
              ],
            },
          ],
        }),
      ),
    );

    const [row] = output.components;
    const action = row?.kind === 'buttons' ? row.buttons[0]?.action : undefined;
    expect(action).toEqual({ kind: 'reply', content: '{server}', ephemeral: true });
  });

  test('leaves the message it was given unchanged', () => {
    const input = message({
      content: '{user}',
      embeds: [{ title: '{server}', thumbnailUrl: '{server.icon_url}' }],
    });
    const before = structuredClone(input);

    render(input);

    expect(input).toEqual(before);
  });
});

describe('collectMessageSites', () => {
  test('lists only allowlisted strings, with the message’s mention settings', () => {
    const sites = collectMessageSites(
      message({
        content: 'Hi',
        mentions: { everyone: false, roles: false, users: true },
        components: [
          {
            kind: 'buttons',
            buttons: [
              {
                key: 'hi',
                style: 'primary',
                label: 'Hi {user}',
                emoji: { name: 'wave' },
                action: { kind: 'reply', content: 'Hello {user}', ephemeral: true },
              },
            ],
          },
        ],
        v2: [],
      }),
      'welcomeMessage',
    );

    expect(sites.map(({ path, text }) => [path, text])).toEqual([
      ['welcomeMessage.content', 'Hi'],
      ['welcomeMessage.components.0.buttons.0.label', 'Hi {user}'],
    ]);
    expect(sites[0]?.mentions).toEqual({ everyone: false, roles: false, users: true });
    expect(sites[1]?.spec.kind).toBe('plain_text');
  });

  test('a message without stored mention settings uses the defaults', () => {
    const [site] = collectMessageSites({ content: 'Hi' }, '');

    expect(site?.path).toBe('content');
    expect(site?.mentions).toEqual({ everyone: false, roles: true, users: true });
  });

  test('reply actions are collected only when asked for', () => {
    const withReplies = message({
      components: [
        {
          kind: 'buttons',
          buttons: [
            {
              key: 'a',
              style: 'primary',
              label: 'A',
              action: { kind: 'reply', content: 'Hello {user}', ephemeral: true },
            },
            {
              key: 'b',
              style: 'primary',
              label: 'B',
              action: { kind: 'role', mode: 'add', roleId: ROLE_ID },
            },
          ],
        },
      ],
    });

    expect(
      collectMessageSites(withReplies, 'templates.0', REPLY_ACTION_FIELDS).map(({ path }) => path),
    ).toEqual(['templates.0.components.0.buttons.0.action.content']);
  });

  test('never throws on a shape it does not recognise', () => {
    for (const garbage of [
      null,
      'hello',
      42,
      [],
      { embeds: 'no' },
      { embeds: [null, 5, { title: 7, fields: {} }], components: [{ buttons: 'x' }] },
      { v2: [{ children: [{ text: 'not an array' }] }] },
    ]) {
      expect(collectMessageSites(garbage, 'x')).toEqual([]);
    }
  });
});
