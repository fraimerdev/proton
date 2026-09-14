import { describe, expect, test } from 'bun:test';
import {
  type ContainerChild,
  type EntitlementTier,
  encodeCustomId,
  type ProtonMessage,
  parseCustomId,
  substitute,
  toDiscordMessage,
  type V2Component,
} from '@proton/core';
import {
  definitionsFor,
  formatTemplateIssues,
  type PlaceholderLookup,
  type PlaceholderSurface,
  renderMessageTemplate,
  renderTemplate,
  SAMPLE_NOW,
  validateConfigTemplates,
} from '@proton/core/placeholders';
import {
  HONEYPOT_ACTIONS,
  type HoneypotConfig,
  type HoneypotLayout,
  honeypotDefaultConfig,
  MODULE_ID,
} from '../src/config.ts';
import { honeypotModule } from '../src/index.ts';
import {
  APPEAL_KEY,
  COUNTER_KEY,
  DM_BODY,
  DM_HEADING,
  HONEYPOT_POT,
  INVITE_KEY,
  NOTICE_BODY,
  NOTICE_HEADING,
  QUIET_NOTICE_BODY,
  RECOVERY_ADVICE,
} from '../src/layout.ts';
import {
  appendRow,
  buildNoticeComponents,
  caughtLabel,
  consequenceOf,
  DM_ACTION_WORD,
  layoutFor,
  noticePlaceholderFacts,
  noticePlaceholderKeys,
  purgeSentence,
  STATS_ACTION,
} from '../src/notice.ts';
import {
  HONEYPOT_DM_EVENT,
  HONEYPOT_DM_SURFACE,
  HONEYPOT_NOTICE_EVENT,
  HONEYPOT_NOTICE_SURFACE,
  honeypotTemplates,
} from '../src/placeholders.ts';
import {
  type DmFacts,
  dmPlaceholderFacts,
  dmPlaceholderKeys,
  renderDirectMessage,
} from '../src/render.ts';

const GUILD = '900000000000000001';
const TRAP = '500000000000000001';
const ZERO_WIDTH_SPACE = '​';
const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}';
const APPEAL_URL = 'https://prtn.xyz/appeal/signed-token';
const INVITE_URL = 'https://discord.gg/example';

type Node = Record<string, unknown>;
type Tier = EntitlementTier | undefined;
type Built = { ok: true; components: Node[] } | { ok: false; humanReason: string };

const TIERS: readonly Tier[] = [undefined, 'free', 'plus'];

function withConfig(overrides: Partial<HoneypotConfig> = {}): HoneypotConfig {
  return { ...honeypotDefaultConfig, ...overrides };
}

function layout(...children: ContainerChild[]): HoneypotLayout {
  return {
    mentions: { everyone: false, roles: false, users: false },
    embeds: [],
    components: [],
    v2: [{ kind: 'container', children }],
  };
}

function linkRow(key: string, label: string, url: string): ContainerChild {
  return { kind: 'row', row: { kind: 'buttons', buttons: [{ key, style: 'link', label, url }] } };
}

function childrenOf(node: Node): Node[] {
  const nested = Array.isArray(node.components) ? (node.components as Node[]) : [];
  const accessory =
    typeof node.accessory === 'object' && node.accessory !== null ? [node.accessory as Node] : [];

  return [...nested, ...accessory];
}

function ofType(nodes: readonly Node[], type: number): Node[] {
  return nodes.flatMap((node) => (node.type === type ? [node] : ofType(childrenOf(node), type)));
}

function texts(nodes: readonly Node[]): string[] {
  return ofType(nodes, 10).map((node) => String(node.content));
}

function buttons(nodes: readonly Node[]): Node[] {
  return ofType(nodes, 2);
}

function componentsOf(built: Built): Node[] {
  if (!built.ok) throw new Error(built.humanReason);
  return built.components;
}

function discordComponents(message: ProtonMessage, customIdFor: (key: string) => string): Node[] {
  return (toDiscordMessage(message, { customIdFor }).components ?? []) as unknown as Node[];
}

function legacyReplaceBody(v2: readonly V2Component[], body: string): V2Component[] {
  let replaced = false;

  return v2.map((component) => {
    if (component.kind !== 'container' || replaced) return component;

    let seen = 0;
    const children = component.children.map((child) => {
      if (child.kind !== 'text') return child;

      seen += 1;
      if (seen !== 2) return child;

      replaced = true;
      return { ...child, content: body };
    });

    return { ...component, children };
  });
}

function legacyNotice(config: HoneypotConfig, caught: number, tier: Tier): Node[] {
  const vars = { consequence: consequenceOf(config.action), purge: purgeSentence(config) };
  const substituted = substitute(layoutFor(config, 'noticeLayout', tier), vars) as ProtonMessage;

  const body = config.hideWhatIsAHoneypot
    ? legacyReplaceBody(substituted.v2, substitute(QUIET_NOTICE_BODY, vars) as string)
    : substituted.v2;

  const v2 = config.noticeCounterButton
    ? appendRow(body, {
        kind: 'row',
        row: {
          kind: 'buttons',
          buttons: [
            {
              key: COUNTER_KEY,
              style: 'secondary',
              label: caughtLabel(config.action, caught),
              emoji: { name: HONEYPOT_POT },
            },
          ],
        },
      })
    : body;

  const customId = encodeCustomId(MODULE_ID, STATS_ACTION, TRAP);
  if (!customId.ok) throw new Error(customId.humanReason);

  return discordComponents({ ...substituted, v2 }, () => customId.customId);
}

function legacyDm(config: HoneypotConfig, tier: Tier, guildName: string, appealUrl?: string) {
  const substituted = substitute(layoutFor(config, 'dmLayout', tier), {
    server: guildName,
    action: DM_ACTION_WORD[config.action],
  }) as ProtonMessage;

  const extra: V2Component[] = [
    { kind: 'separator', divider: true, spacing: 'small' },
    { kind: 'text', content: RECOVERY_ADVICE },
  ];

  const links: Array<{ key: string; style: 'link'; label: string; url: string }> = [];
  if (appealUrl && config.action === 'ban') {
    links.push({ key: APPEAL_KEY, style: 'link', label: 'Appeal', url: appealUrl });
  }
  if (config.offerWayBackIn && config.inviteUrl) {
    links.push({ key: INVITE_KEY, style: 'link', label: 'Rejoin', url: config.inviteUrl });
  }
  if (links.length > 0) extra.push({ kind: 'row', row: { kind: 'buttons', buttons: links } });

  const v2 = extra.reduce<V2Component[]>(
    (carried, component) => appendRow(carried, component),
    [...substituted.v2],
  );

  return discordComponents({ ...substituted, v2 }, (key) => key);
}

const LEGACY_NOTICE_LAYOUT = layout(
  { kind: 'text', content: NOTICE_HEADING },
  { kind: 'text', content: NOTICE_BODY },
  {
    kind: 'section',
    text: ['Posting here means **{consequence}**.{purge}', 'Not {server}, {action} or {nobody}.'],
    accessory: {
      kind: 'thumbnail',
      url: 'https://cdn.example.com/pot.png',
      description: 'What happens: {consequence}',
    },
  },
  linkRow('rules', 'Why: {consequence}', 'https://example.com/rules'),
);

const LEGACY_DM_LAYOUT = layout(
  { kind: 'text', content: DM_HEADING },
  { kind: 'text', content: DM_BODY },
  {
    kind: 'section',
    text: ['You were **{action}** in **{server}**.', '{server} / {consequence} / {constructor}'],
    accessory: {
      kind: 'thumbnail',
      url: 'https://cdn.example.com/pot.png',
      description: '{server}: {action}',
    },
  },
  linkRow('rules', '{server} rules', 'https://example.com/rules'),
);

const GUILD_NAMES = [
  'Test Guild',
  'Proton_Test *',
  '**Proton** <@&1> [a](b) {action} # not a heading',
  '',
];

describe('legacy notices render byte-identically', () => {
  for (const action of HONEYPOT_ACTIONS) {
    test(`${action}: {consequence} and {purge}, every switch, every tier`, () => {
      for (const deleteMessageSeconds of [0, 86_400]) {
        for (const hideWhatIsAHoneypot of [false, true]) {
          for (const noticeCounterButton of [true, false]) {
            for (const noticeLayout of [honeypotDefaultConfig.noticeLayout, LEGACY_NOTICE_LAYOUT]) {
              const settings = withConfig({
                action,
                deleteMessageSeconds,
                hideWhatIsAHoneypot,
                noticeCounterButton,
                noticeLayout,
              });

              for (const tier of TIERS) {
                const built = buildNoticeComponents(settings, TRAP, 7, tier, {
                  guildId: GUILD,
                  now: SAMPLE_NOW,
                });

                expect(componentsOf(built)).toEqual(legacyNotice(settings, 7, tier));
              }
            }
          }
        }
      }
    });
  }

  test('the fixtures exercise the purge sentence, the quiet body and the older names', () => {
    const ban = withConfig({
      action: 'ban',
      deleteMessageSeconds: 86_400,
      noticeLayout: LEGACY_NOTICE_LAYOUT,
    });
    const said = texts(legacyNotice(ban, 7, 'plus')).join('\n');

    expect(said).toContain('Everything you posted in the last day is deleted with you.');
    expect(said).toContain('Not {server}, {action} or {nobody}.');
    expect(texts(legacyNotice({ ...ban, hideWhatIsAHoneypot: true }, 7, 'plus'))).toContain(
      'Nobody has any reason to post in this channel. Anything sent here means **you are banned ' +
        'from the server**. Everything you posted in the last day is deleted with you.\n\n' +
        'There is never a reason to post here.',
    );
  });
});

describe('legacy direct messages render byte-identically', () => {
  for (const action of HONEYPOT_ACTIONS) {
    test(`${action}: {server} and {action}, with and without the buttons Proton appends`, () => {
      for (const dmLayout of [honeypotDefaultConfig.dmLayout, LEGACY_DM_LAYOUT]) {
        for (const invite of [false, true]) {
          const settings = withConfig({
            action,
            dmLayout,
            ...(invite ? { offerWayBackIn: true, inviteUrl: INVITE_URL } : {}),
          });

          for (const tier of TIERS) {
            for (const guildName of GUILD_NAMES) {
              const built = renderDirectMessage(
                settings,
                tier,
                { guildName, appealUrl: APPEAL_URL },
                SAMPLE_NOW,
              );

              expect(componentsOf(built)).toEqual(legacyDm(settings, tier, guildName, APPEAL_URL));
            }
          }
        }
      }
    });
  }

  test('the fixtures exercise the hostile names and the older names', () => {
    const settings = withConfig({ dmLayout: LEGACY_DM_LAYOUT });
    const said = texts(legacyDm(settings, 'plus', GUILD_NAMES[2] ?? '')).join('\n');

    expect(said).toContain('in ****Proton** <@&1> [a](b) {action} # not a heading**');
    expect(said).toContain('/ {consequence} / {constructor}');
  });
});

describe('an older name in a link', () => {
  const PATH = 'dmLayout.v2.0.children.1.row.buttons.0.url';
  const settings = withConfig({
    dmLayout: layout(
      { kind: 'text', content: DM_BODY },
      linkRow('where', 'Where', 'https://example.com/{server}?why={action}'),
    ),
  });

  test('{server} is written link-safe, and {action} cannot go in a link at all', () => {
    const sent = componentsOf(
      renderDirectMessage(settings, 'plus', { guildName: 'Proton HQ' }, SAMPLE_NOW),
    );

    expect(buttons(sent)[0]?.url).toBe('https://example.com/Proton%20HQ?why=');
  });

  test('the editor notes the one written link-safe, and blocks the one that renders nothing', () => {
    const report = validateConfigTemplates(honeypotTemplates, settings, honeypotDefaultConfig);
    const codes = report.byPath.get(PATH)?.map(({ code }) => code) ?? [];

    expect(codes.filter((code) => code === 'legacy_alias_in_url')).toHaveLength(1);
    expect(report.blocking.map(({ path, diagnostic }) => [path, diagnostic.code])).toEqual([
      [PATH, 'incompatible_field'],
    ]);
  });
});

describe('the appeal link is private to the member it is about', () => {
  const PATH = 'noticeLayout.v2.0.children.0.content';
  const APPEAL_TEXT = 'Appeal: {honeypot.appeal_url}';
  const notice = withConfig({ noticeLayout: layout({ kind: 'text', content: APPEAL_TEXT }) });

  test('typed into the notice, the save is refused and the field is named', () => {
    const report = validateConfigTemplates(honeypotTemplates, notice, honeypotDefaultConfig);

    expect(report.blocking.map(({ path, diagnostic }) => [path, diagnostic.code])).toEqual([
      [PATH, 'restricted'],
    ]);
    expect(formatTemplateIssues(report)).toStartWith(
      `${PATH} Text: {honeypot.appeal_url} may only be shown to`,
    );
  });

  test('an unchanged stored one does not block an unrelated save', () => {
    const report = validateConfigTemplates(
      honeypotTemplates,
      { ...notice, postNotice: false },
      notice,
    );

    expect(report.blocking).toEqual([]);
    expect(report.byPath.get(PATH)?.map(({ code }) => code)).toContain('restricted');
  });

  test('in the direct message it is allowed, because the member reads it', () => {
    const dm = withConfig({ dmLayout: layout({ kind: 'text', content: APPEAL_TEXT }) });

    expect(validateConfigTemplates(honeypotTemplates, dm, honeypotDefaultConfig).blocking).toEqual(
      [],
    );
  });

  test('on the notice it posts nothing in its place, and is never looked up', () => {
    const asked: string[] = [];
    const facts = noticePlaceholderFacts(notice, TRAP, 3, { guildId: GUILD });
    const inner = HONEYPOT_NOTICE_SURFACE.build(facts, { now: SAMPLE_NOW });
    const lookup: PlaceholderLookup = (request) => {
      asked.push(request.canonical);
      return inner(request);
    };

    const rendered = renderMessageTemplate(
      layoutFor(notice, 'noticeLayout', 'plus'),
      HONEYPOT_NOTICE_SURFACE,
      lookup,
      { now: SAMPLE_NOW, basePath: 'noticeLayout' },
    );
    if (!rendered.ok) throw new Error(rendered.humanReason);

    expect(asked).toEqual([]);
    expect(rendered.diagnostics.map(({ path, code }) => [path, code])).toEqual([
      [PATH, 'restricted'],
    ]);
    expect(
      texts(componentsOf(buildNoticeComponents(notice, TRAP, 3, 'plus', { guildId: GUILD })))[0],
    ).toBe('Appeal: ');
  });

  test('no notice picker offers it, and the direct message picker does', () => {
    const noticeKeys = definitionsFor(HONEYPOT_NOTICE_SURFACE.registry, {
      field: 'url',
      event: HONEYPOT_NOTICE_EVENT,
      audience: 'public',
    }).map(({ key }) => key);

    expect(noticeKeys).not.toContain('honeypot.appeal_url');
    expect(
      HONEYPOT_NOTICE_SURFACE.pickerFor('noticeLayout.v2.0.children.0.row.buttons.0.url').map(
        ({ key }) => key,
      ),
    ).not.toContain('honeypot.appeal_url');
    expect(
      HONEYPOT_DM_SURFACE.pickerFor('dmLayout.v2.0.children.0.row.buttons.0.url').map(
        ({ key }) => key,
      ),
    ).toContain('honeypot.appeal_url');
  });

  test('in the direct message it is the ban’s own link, and nothing on any other action', () => {
    const textFor = (action: HoneypotConfig['action']) =>
      texts(
        componentsOf(
          renderDirectMessage(
            withConfig({ action, dmLayout: layout({ kind: 'text', content: APPEAL_TEXT }) }),
            'plus',
            { guildName: 'Test Guild', appealUrl: APPEAL_URL },
            SAMPLE_NOW,
          ),
        ),
      )[0];

    expect(textFor('ban')).toBe(`Appeal: ${APPEAL_URL}`);
    expect(textFor('softban')).toBe('Appeal: ');
  });
});

describe('the notice only changes when someone is caught', () => {
  const PATH = 'noticeLayout.v2.0.children.0.content';
  const CLOCKED =
    'Caught {honeypot.caught} as of {now}{today}{year}, {honeypot.caught_last_week} this week.';
  const clocked = withConfig({ noticeLayout: layout({ kind: 'text', content: CLOCKED }) });

  test('a clock is refused at save, and a rolling count is not a placeholder', () => {
    const report = validateConfigTemplates(honeypotTemplates, clocked, honeypotDefaultConfig);
    const codes = report.byPath.get(PATH)?.map(({ code }) => code) ?? [];

    expect(codes.filter((code) => code === 'unavailable')).toHaveLength(3);
    expect(codes).toContain('unknown_placeholder');
    expect(report.blocking.map(({ diagnostic }) => diagnostic.code)).toEqual([
      'unavailable',
      'unavailable',
      'unavailable',
    ]);
  });

  test('the clock posts as nothing and the rolling count as written', () => {
    const built = buildNoticeComponents(clocked, TRAP, 3, 'plus', {
      guildId: GUILD,
      now: SAMPLE_NOW,
    });

    expect(texts(componentsOf(built))[0]).toBe(
      'Caught 3 as of , {honeypot.caught_last_week} this week.',
    );
  });

  test('the notice picker offers neither, and the direct message offers the clock', () => {
    const notice = definitionsFor(HONEYPOT_NOTICE_SURFACE.registry, {
      field: 'discord_text',
      event: HONEYPOT_NOTICE_EVENT,
      audience: 'public',
    }).map(({ key }) => key);

    for (const key of [
      'now',
      'today',
      'year',
      'honeypot.caught_last_week',
      'honeypot.caught_last_day',
    ]) {
      expect(notice).not.toContain(key);
    }
    expect(notice).toEqual(
      expect.arrayContaining(['honeypot.caught', 'honeypot.consequence', 'channel.mention']),
    );

    const dm = definitionsFor(HONEYPOT_DM_SURFACE.registry, {
      field: 'discord_text',
      event: HONEYPOT_DM_EVENT,
      audience: 'member_private',
    }).map(({ key }) => key);

    expect(dm).toEqual(
      expect.arrayContaining([
        'now',
        'today',
        'year',
        'honeypot.action',
        'honeypot.appeal_url',
        'honeypot.invite_url',
        'server.name',
        'user.global_name',
      ]),
    );
    expect(dm).not.toContain('honeypot.caught');
  });

  test('the direct message fills in the moment it was sent', () => {
    const settings = withConfig({
      dmLayout: layout(
        { kind: 'text', content: 'Sent {now:date} in {year}.' },
        linkRow('when', 'Sent {now:date}', 'https://example.com/when'),
      ),
    });

    const sent = componentsOf(
      renderDirectMessage(settings, 'plus', { guildName: 'Test Guild' }, SAMPLE_NOW),
    );
    const label = String(buttons(sent)[0]?.label);

    expect(texts(sent)[0]).toBe(`Sent <t:${Math.floor(SAMPLE_NOW / 1000)}:d> in 2026.`);
    expect(label).toStartWith('Sent ');
    expect(label).toContain('2026');
    expect(label).not.toContain('<t:');
  });
});

describe('a free guild', () => {
  const stored = withConfig({
    noticeLayout: layout({ kind: 'text', content: '{server.name} has caught {honeypot.caught}' }),
    dmLayout: layout({ kind: 'text', content: 'Hi {user.global_name}, from {bot.name}' }),
  });

  test('posts the built-in layouts whatever placeholders its stored ones hold', () => {
    for (const tier of [undefined, 'free'] as const) {
      const notice = buildNoticeComponents(stored, TRAP, 3, tier, { guildId: GUILD });
      const dm = renderDirectMessage(stored, tier, { guildName: 'Test Guild' }, SAMPLE_NOW);

      expect(componentsOf(notice)).toEqual(legacyNotice(stored, 3, tier));
      expect(componentsOf(dm)).toEqual(legacyDm(stored, tier, 'Test Guild'));
    }
  });

  test('asks for nothing the built-in layouts do not use', () => {
    expect([...noticePlaceholderKeys(stored, 'free')].sort()).toEqual([
      'honeypot.consequence',
      'honeypot.purge',
    ]);
    expect([...dmPlaceholderKeys(stored, 'free')].sort()).toEqual([
      'honeypot.action',
      'server.name',
    ]);
    expect([...noticePlaceholderKeys(stored, 'plus')].sort()).toEqual([
      'honeypot.caught',
      'server.name',
    ]);
    expect([...dmPlaceholderKeys(stored, 'plus')].sort()).toEqual(['bot.name', 'user.global_name']);
  });
});

describe('only the fields that hold text are filled in', () => {
  test('the counter appended after the render, and a stored button’s emoji, are untouched', () => {
    const settings = withConfig({
      noticeLayout: layout(
        { kind: 'text', content: 'Caught {honeypot.caught}' },
        {
          kind: 'row',
          row: {
            kind: 'buttons',
            buttons: [
              {
                key: 'rules',
                style: 'link',
                label: 'Rules',
                emoji: { name: '{purge}' },
                url: 'https://example.com/rules',
              },
            ],
          },
        },
      ),
    });

    const sent = componentsOf(buildNoticeComponents(settings, TRAP, 3, 'plus', { guildId: GUILD }));
    const [link, counter] = buttons(sent);

    expect(texts(sent)).toEqual(['Caught 3']);
    expect(link?.emoji).toEqual({ name: '{purge}' });
    expect(counter?.label).toBe(caughtLabel('softban', 3));
    expect(counter?.emoji).toEqual({ name: HONEYPOT_POT });
    expect(parseCustomId(counter?.custom_id)).toEqual({
      moduleId: MODULE_ID,
      action: STATS_ACTION,
      args: [TRAP],
    });
  });

  test('the recovery advice and the buttons Proton appends to the direct message are untouched', () => {
    const settings = withConfig({
      action: 'ban',
      offerWayBackIn: true,
      inviteUrl: 'https://discord.gg/{server}',
    });

    const sent = componentsOf(
      renderDirectMessage(
        settings,
        'plus',
        { guildName: 'Proton HQ', appealUrl: `${APPEAL_URL}?{action}` },
        SAMPLE_NOW,
      ),
    );

    expect(texts(sent).at(-1)).toBe(RECOVERY_ADVICE);
    expect(buttons(sent).map(({ url }) => url)).toEqual([
      `${APPEAL_URL}?{action}`,
      'https://discord.gg/{server}',
    ]);
  });
});

describe('prototype names', () => {
  const PROTOTYPE = '{constructor} {__proto__} {prototype} {user.constructor} {honeypot.__proto__}';

  test('are posted as written on both surfaces', () => {
    const settings = withConfig({
      noticeLayout: layout({ kind: 'text', content: PROTOTYPE }),
      dmLayout: layout({ kind: 'text', content: PROTOTYPE }),
    });

    const notice = componentsOf(
      buildNoticeComponents(settings, TRAP, 3, 'plus', { guildId: GUILD }),
    );
    const dm = componentsOf(
      renderDirectMessage(settings, 'plus', { guildName: 'Test Guild' }, SAMPLE_NOW),
    );

    expect(texts(notice)[0]).toBe(PROTOTYPE);
    expect(texts(dm)[0]).toBe(PROTOTYPE);
    expect(() => validateConfigTemplates(honeypotTemplates, settings)).not.toThrow();
  });
});

describe('a server name is a value, never a template', () => {
  const HOSTILE = '{action} <@&100000000000000020> **x** @everyone';

  test('through {server.name} it is escaped, never expanded, and cannot ping', () => {
    const settings = withConfig({
      dmLayout: layout({ kind: 'text', content: 'From {server.name}.' }),
    });

    const [text] = texts(
      componentsOf(
        renderDirectMessage(
          settings,
          'plus',
          { guildName: 'Test Guild', server: { id: GUILD, name: HOSTILE } },
          SAMPLE_NOW,
        ),
      ),
    );

    expect(text).toContain('{action}');
    expect(text).not.toContain(DM_ACTION_WORD.softban);
    expect(text).not.toMatch(/(^|[^\\])<@&/);
    expect(text).toContain(`@${ZERO_WIDTH_SPACE}everyone`);
  });

  test('through the older {server} it posts as before, except that @everyone is broken', () => {
    const template = 'From {server}, you were {action}.';
    const settings = withConfig({ dmLayout: layout({ kind: 'text', content: template }) });

    const [text] = texts(
      componentsOf(renderDirectMessage(settings, 'plus', { guildName: HOSTILE }, SAMPLE_NOW)),
    );
    const legacy = substitute(template, {
      server: HOSTILE,
      action: DM_ACTION_WORD.softban,
    }) as string;

    expect(legacy).toContain('@everyone');
    expect(text).toBe(legacy.replace('@everyone', `@${ZERO_WIDTH_SPACE}everyone`));
  });

  test('{server} is the name Proton holds for the server, else the name it was handed', () => {
    const settings = withConfig({ dmLayout: layout({ kind: 'text', content: 'From {server}.' }) });
    const from = (facts: DmFacts) =>
      texts(componentsOf(renderDirectMessage(settings, 'plus', facts, SAMPLE_NOW)))[0];

    expect(from({ guildName: 'this server' })).toBe('From this server.');
    expect(from({ guildName: 'this server', server: { id: GUILD } })).toBe('From this server.');
    expect(from({ guildName: 'Old Name', server: { id: GUILD, name: 'Proton HQ' } })).toBe(
      'From Proton HQ.',
    );
  });
});

describe('Discord’s limits hold once the placeholders are filled in', () => {
  const LONG = 'P'.repeat(300);

  function sentWith(settings: HoneypotConfig, name: string): Node[] {
    return componentsOf(
      renderDirectMessage(
        settings,
        'plus',
        { guildName: 'Test Guild', server: { id: GUILD, name } },
        SAMPLE_NOW,
      ),
    );
  }

  test('a text display is clipped to 4000', () => {
    const settings = withConfig({
      dmLayout: layout({ kind: 'text', content: '{server.name}'.repeat(20) }),
    });

    expect(texts(sentWith(settings, LONG))[0]).toBe('P'.repeat(4000));
  });

  test('a button label is clipped to 80, never through an emoji', () => {
    const settings = withConfig({
      dmLayout: layout(
        { kind: 'text', content: 'Hello' },
        linkRow('from', '{server.name}', 'https://example.com/'),
      ),
    });

    expect(buttons(sentWith(settings, LONG))[0]?.label).toBe('P'.repeat(80));

    const family = String(buttons(sentWith(settings, FAMILY.repeat(200)))[0]?.label);

    expect(family.length).toBeGreaterThan(0);
    expect(family.length).toBeLessThanOrEqual(80);
    expect(family).toBe(FAMILY.repeat(family.length / FAMILY.length));

    const rendered = renderMessageTemplate(
      settings.dmLayout,
      HONEYPOT_DM_SURFACE,
      HONEYPOT_DM_SURFACE.build(
        dmPlaceholderFacts(settings, {
          guildName: 'Test Guild',
          server: { id: GUILD, name: LONG },
        }),
        { now: SAMPLE_NOW },
      ),
      { now: SAMPLE_NOW, basePath: 'dmLayout' },
    );

    expect(rendered.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'output_truncated',
        path: 'dmLayout.v2.0.children.1.row.buttons.0.label',
      }),
    );
  });

  test('an image description is clipped to 1024', () => {
    const settings = withConfig({
      dmLayout: layout({
        kind: 'section',
        text: ['Hello'],
        accessory: {
          kind: 'thumbnail',
          url: 'https://cdn.example.com/pot.png',
          description: '{server.name}'.repeat(5),
        },
      }),
    });

    expect(ofType(sentWith(settings, LONG), 11)[0]?.description).toBe('P'.repeat(1024));
  });
});

function sampleCodes<F>(surface: PlaceholderSurface<F>, path: string): string[] {
  const [sample] = surface.samples;
  if (sample === undefined) throw new Error(`${surface.id} has no sample`);

  const lookup = surface.build(sample.facts, { now: SAMPLE_NOW });

  return surface.pickerFor(path).flatMap(({ key }) =>
    renderTemplate(`{${key}}`, lookup, {
      registry: surface.registry,
      field: 'discord_text',
      event: surface.event,
      audience: surface.audience,
      now: SAMPLE_NOW,
    }).diagnostics.map(({ code }) => `${key}:${code}`),
  );
}

describe('the two honeypot surfaces', () => {
  test('are the manifest’s templates, each with the audience that reads it', () => {
    expect(honeypotModule.templates).toBe(honeypotTemplates);
    expect(Object.keys(honeypotTemplates.surfaces).sort()).toEqual([
      'honeypot.dm',
      'honeypot.notice',
    ]);
    expect([HONEYPOT_NOTICE_SURFACE.event, HONEYPOT_NOTICE_SURFACE.audience]).toEqual([
      HONEYPOT_NOTICE_EVENT,
      'public',
    ]);
    expect([HONEYPOT_DM_SURFACE.event, HONEYPOT_DM_SURFACE.audience]).toEqual([
      HONEYPOT_DM_EVENT,
      'member_private',
    ]);
  });

  test('keep each older name on the surface that had it, and only there', () => {
    const canonical =
      (surface: typeof HONEYPOT_NOTICE_SURFACE | typeof HONEYPOT_DM_SURFACE) => (key: string) =>
        surface.registry.resolve(key)?.canonical;

    const notice = canonical(HONEYPOT_NOTICE_SURFACE);
    const dm = canonical(HONEYPOT_DM_SURFACE);

    expect(notice('consequence')).toBe('honeypot.consequence');
    expect(notice('purge')).toBe('honeypot.purge');
    expect(notice('action')).toBeUndefined();
    expect(notice('server')).toBeUndefined();
    expect(dm('action')).toBe('honeypot.action');
    expect(dm('server')).toBe('server.name');
    expect(dm('consequence')).toBeUndefined();
  });

  test('collect every text of both stored layouts, each under its own surface', () => {
    expect(
      honeypotTemplates
        .collect(honeypotDefaultConfig)
        .map(({ path, surfaceId }) => [path, surfaceId]),
    ).toEqual([
      ['noticeLayout.v2.0.children.0.content', 'honeypot.notice'],
      ['noticeLayout.v2.0.children.1.content', 'honeypot.notice'],
      ['dmLayout.v2.0.children.0.content', 'honeypot.dm'],
      ['dmLayout.v2.0.children.1.content', 'honeypot.dm'],
    ]);
    expect(honeypotTemplates.collect('not a config')).toEqual([]);
  });

  test('the shipped layouts pass, with only notes about their older names', () => {
    const report = validateConfigTemplates(honeypotTemplates, honeypotDefaultConfig);
    const codes = [...report.byPath.values()].flat().map(({ code }) => code);

    expect(report.blocking).toEqual([]);
    expect(new Set(codes)).toEqual(new Set(['legacy_alias']));
  });

  test('an unchanged stored mistake never blocks a toggle, and a new one names its field', () => {
    const broken = withConfig({
      noticeLayout: layout({ kind: 'text', content: 'Caught {honeypot.caught:shout}' }),
    });

    expect(
      validateConfigTemplates(honeypotTemplates, { ...broken, enabled: true }, broken).blocking,
    ).toEqual([]);

    const report = validateConfigTemplates(honeypotTemplates, broken, honeypotDefaultConfig);

    expect(report.blocking.map(({ path }) => path)).toEqual([
      'noticeLayout.v2.0.children.0.content',
    ]);
    expect(report.blocking[0]?.diagnostic.severity).toBe('error');
  });

  test('every sample fills in each placeholder its picker offers', () => {
    const notice = sampleCodes(HONEYPOT_NOTICE_SURFACE, 'noticeLayout.v2.0.children.0.content');
    const dm = sampleCodes(HONEYPOT_DM_SURFACE, 'dmLayout.v2.0.children.0.content');

    expect([...notice, ...dm].filter((code) => !code.endsWith(':not_set'))).toEqual([]);
  });
});
