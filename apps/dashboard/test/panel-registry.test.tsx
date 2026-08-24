import { beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMPTY_MESSAGE } from '@proton/core';
import { automodConfigSchema } from '@proton/module-automod/config';
import { casesConfigSchema } from '@proton/module-cases';
import { countersConfigSchema } from '@proton/module-counters/config';
import { honeypotConfigSchema } from '@proton/module-honeypot/config';
import { levelingConfigSchema } from '@proton/module-leveling/config';
import { messagesConfigSchema } from '@proton/module-messages/config';
import { permissionsConfigSchema } from '@proton/module-permissions';
import { rolemenuConfigSchema } from '@proton/module-rolemenu/config';
import { serverlogConfigSchema } from '@proton/module-serverlog/config';
import { tempVcConfigSchema } from '@proton/module-tempvc/config';
import { ticketsConfigSchema } from '@proton/module-tickets/config';
import { verificationConfigSchema } from '@proton/module-verification/config';
import { welcomeConfigSchema } from '@proton/module-welcome/config';
import { renderToStaticMarkup } from 'react-dom/server';
import type { z } from 'zod';
import {
  applyPanels,
  initialPanelValues,
  MODULE_PANELS,
  type PanelEntry,
  panelDescriptors,
  panelsFor,
} from '../src/components/panels/registry.ts';

const CONFIG_SCHEMAS: Record<string, z.ZodObject> = {
  automod: automodConfigSchema,
  cases: casesConfigSchema,
  leveling: levelingConfigSchema,
  permissions: permissionsConfigSchema,
  rolemenu: rolemenuConfigSchema,
  serverlog: serverlogConfigSchema,
  counters: countersConfigSchema,
  honeypot: honeypotConfigSchema,
  messages: messagesConfigSchema,
  tickets: ticketsConfigSchema,
  verification: verificationConfigSchema,
  tempvc: tempVcConfigSchema,
  welcome: welcomeConfigSchema,
};

const CHANNELS = [
  { id: '500000000000000001', name: 'general', type: 0 },
  { id: '500000000000000002', name: 'voice', type: 2 },
];

const ROLES = [
  { id: '600000000000000001', name: 'Moderator', position: 5 },
  { id: '600000000000000002', name: 'Member', position: 1 },
];

const HONEYPOT_ROW = {
  channelId: '500000000000000001',
  enabled: true,
  action: 'softban',
  deleteMessageSeconds: 604_800,
  timeoutDuration: '1h',
};

const LIVE_CONFIG: Record<string, Record<string, unknown>> = {
  automod: automodConfigSchema.parse({ enabled: true, blockedWords: ['scam'] }),
  cases: {},
  leveling: {},
  rolemenu: {},
  serverlog: {
    defaultChannelId: '500000000000000001',
    categoryChannels: {},
    categories: { members: true },
  },
  tickets: {},
  tempvc: {},
  messages: {},
  counters: {},
  welcome: {},
  honeypot: { channels: [HONEYPOT_ROW] },
};

// The registry holds every editor lazily so a module with no panel ships none of them; the module
// loader preloads the ones it needs, and rendering one here has to do the same.
beforeAll(async () => {
  await Promise.all(
    Object.values(MODULE_PANELS).flatMap((spec) =>
      spec.panels.map((entry) => entry.Panel.preload?.()),
    ),
  );
});

function renderPanel(moduleId: string, entry: PanelEntry, value: unknown): string {
  const Panel = entry.Panel;

  return renderToStaticMarkup(
    <Panel
      value={value}
      onChange={() => undefined}
      channels={CHANNELS}
      roles={ROLES}
      liveConfig={LIVE_CONFIG[moduleId] ?? {}}
      guildId="900000000000000001"
    />,
  );
}

describe('the module panel registry', () => {
  test('the six modules migrated off the if-chain declare exactly the panels they had', () => {
    // Scoped to the six on purpose: this guards the migration, so a module added afterwards must
    // not have to be listed here to keep it passing.
    const migrated = ['cases', 'leveling', 'rolemenu', 'automod', 'serverlog', 'permissions'];

    const declared = Object.fromEntries(
      migrated.map((id) => [id, panelsFor(id).map((p) => [p.key, p.title])]),
    );

    expect(declared).toEqual({
      cases: [['escalationLadder', 'Warn escalation']],
      leveling: [
        ['levelUpMessage', 'Level-up message'],
        ['roleRewards', 'Role rewards'],
        [null, 'Rank card preview'],
      ],
      rolemenu: [['menus', 'Role menus']],
      automod: [[null, 'Who enforces what']],
      serverlog: [['events', 'Individual logs']],
      permissions: [],
    });
  });

  test('every registered panel resolves to a component', () => {
    for (const [id, spec] of Object.entries(MODULE_PANELS)) {
      for (const entry of spec.panels) {
        expect(`${id}/${entry.title}: ${typeof entry.Panel}`).toBe(
          `${id}/${entry.title}: function`,
        );
      }
    }
  });

  test('every panel key is a real key of that module’s config schema', () => {
    for (const [id, spec] of Object.entries(MODULE_PANELS)) {
      const schema = CONFIG_SCHEMAS[id];
      expect(schema).toBeDefined();

      for (const entry of spec.panels) {
        if (entry.key === null) continue;
        expect(Object.keys(schema?.shape ?? {})).toContain(entry.key);
      }
    }
  });

  test('every registered module id is one the dashboard has a config schema for', () => {
    for (const id of Object.keys(MODULE_PANELS)) {
      expect(Object.keys(CONFIG_SCHEMAS)).toContain(id);
    }
  });

  test('every panel renders something for the value its module stores', () => {
    const values: Record<string, unknown> = {
      cases: [{ atWarnings: 3, action: 'timeout', duration: '1h' }],
      leveling: [{ level: 5, roleId: '600000000000000001' }],
      rolemenu: [
        {
          id: 'colours',
          channelId: '500000000000000001',
          kind: 'button',
          mode: 'toggle',
          bindings: [{ key: 'choice-1', roleId: '600000000000000001' }],
        },
      ],
      serverlog: {},
      automod: undefined,
      tickets: [
        {
          id: 'support',
          name: 'Support',
          channelId: '500000000000000001',
          buttonLabel: 'Open a ticket',
          panelText: 'Need a hand?',
          openingMessage: '{user} opened a ticket.',
          supportRoleIds: [],
        },
      ],
      tempvc: [{ channelId: '500000000000000002', nameTemplate: '{user}', userLimit: 0 }],
      messages: [{ name: 'welcome', description: 'Hello' }],
      counters: [
        { channelId: '500000000000000002', template: 'Members: {count}', source: 'members' },
      ],
      welcome: 'Welcome to {server}, {user}!',
      honeypot: [HONEYPOT_ROW],
    };

    // Keyed by panel where a module has more than one shape to render: messages stores a template
    // list under `templates` and a row palette under `components`, and handing either panel the
    // other's value only proves the component crashes on it.
    const perPanel: Record<string, unknown> = {
      'messages/components': [
        {
          name: 'Ticket buttons',
          row: {
            kind: 'buttons',
            buttons: [
              {
                key: 'open',
                label: 'Open',
                style: 'primary',
                action: { kind: 'reply', content: 'Opening', ephemeral: true },
              },
            ],
          },
        },
      ],
    };

    for (const [id, spec] of Object.entries(MODULE_PANELS)) {
      for (const entry of spec.panels) {
        const key = `${id}/${entry.key ?? entry.title}`;
        const value = Object.hasOwn(perPanel, key) ? perPanel[key] : values[id];

        expect(`${key}: ${renderPanel(id, entry, value).length > 0}`).toBe(`${key}: true`);
      }
    }
  });
});

describe('what a panel contributes when the page is saved', () => {
  test('a keyed panel writes its own value and leaves every other key alone', () => {
    const saved = applyPanels(
      'cases',
      { enabled: true, historyLimit: 10, escalationLadder: [] },
      { escalationLadder: [{ atWarnings: 3, action: 'kick' }] },
    );

    expect(saved).toEqual({
      enabled: true,
      historyLimit: 10,
      escalationLadder: [{ atWarnings: 3, action: 'kick' }],
    });
  });

  test('a derived panel contributes nothing, so automod saves what the form built', () => {
    const config = { enabled: true, blockedWords: ['scam'] };

    expect(applyPanels('automod', config, {})).toEqual(config);
  });

  test('a module with no registered panels saves the form’s config untouched', () => {
    const config = { enabled: true, response: 'Pong!' };

    expect(panelsFor('ping')).toEqual([]);
    expect(applyPanels('ping', config, {})).toEqual(config);
  });

  test('a panel whose key is missing from the saved config starts from its empty value', () => {
    expect(initialPanelValues('cases', {})).toEqual({ escalationLadder: [] });
    expect(initialPanelValues('serverlog', {})).toEqual({ events: {} });
    expect(initialPanelValues('leveling', {})).toEqual({
      levelUpMessage: EMPTY_MESSAGE,
      roleRewards: [],
    });
    expect(initialPanelValues('rolemenu', {})).toEqual({ menus: [] });
  });

  test('a derived panel claims no slot in the values a page holds', () => {
    expect(initialPanelValues('automod', { blockedWords: ['scam'] })).toEqual({});
  });

  test('a saved value wins over the empty value', () => {
    const ladder = [{ atWarnings: 4, action: 'ban' }];

    expect(initialPanelValues('cases', { escalationLadder: ladder })).toEqual({
      escalationLadder: ladder,
    });
  });
});

describe('permissions, which injects descriptors and prunes on save', () => {
  test('it declares no panel, so its overrides render through the generated form', () => {
    expect(panelsFor('permissions')).toEqual([]);
  });

  test('its extra descriptors are built from the commands the guild actually has', () => {
    const descriptors = panelDescriptors('permissions', ['ban', 'kick']);

    expect(descriptors.map((d) => d.path)).toEqual(['overrides.ban', 'overrides.kick']);
    for (const descriptor of descriptors) {
      expect(descriptor.kind).toBe('role-id');
      expect(descriptor.array).toBe(true);
    }
  });

  test('no other module injects descriptors', () => {
    for (const id of Object.keys(MODULE_PANELS)) {
      if (id === 'permissions') continue;
      expect(panelDescriptors(id, ['ban'])).toEqual([]);
    }
  });

  test('an override left empty is dropped rather than stored as an empty allow-list', () => {
    const saved = applyPanels(
      'permissions',
      { enabled: true, overrides: { ban: ['600000000000000001'], kick: [] } },
      {},
    );

    expect(saved).toEqual({ enabled: true, overrides: { ban: ['600000000000000001'] } });
  });

  test('overrides that are not an object at all become an empty set, not a crash', () => {
    expect(applyPanels('permissions', { enabled: true }, {})).toEqual({
      enabled: true,
      overrides: {},
    });
  });
});

describe('a module the panel registry has never heard of', () => {
  test('every entry point yields an empty result instead of throwing', () => {
    expect(panelsFor('ping')).toEqual([]);
    expect(initialPanelValues('ping', { response: 'Pong!' })).toEqual({});
    expect(panelDescriptors('ping', ['ban', 'kick'])).toEqual([]);
    expect(applyPanels('ping', { enabled: true, response: 'Pong!' }, {})).toEqual({
      enabled: true,
      response: 'Pong!',
    });
  });

  test('an unregistered module keeps a value that collides with another module’s panel key', () => {
    expect(applyPanels('ping', { menus: ['left alone'] }, { menus: [] })).toEqual({
      menus: ['left alone'],
    });
  });

  const INHERITED = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf'];

  test('a module id that names an Object.prototype member misses rather than resolving to it', () => {
    for (const id of INHERITED) {
      expect(`${id}: ${JSON.stringify(panelsFor(id))}`).toBe(`${id}: []`);
      expect(`${id}: ${JSON.stringify(panelDescriptors(id, ['ban']))}`).toBe(`${id}: []`);
      expect(`${id}: ${JSON.stringify(initialPanelValues(id, { a: 1 }))}`).toBe(`${id}: {}`);
    }
  });

  test('saving under such a module id returns the config instead of throwing', () => {
    for (const id of INHERITED) {
      expect(`${id}: ${JSON.stringify(applyPanels(id, { enabled: true }, {}))}`).toBe(
        `${id}: {"enabled":true}`,
      );
    }
  });
});

describe('the config a module page saves after a round trip through its panels', () => {
  const SAVED: Record<string, Record<string, unknown>> = {
    cases: { enabled: true, escalationLadder: [{ atWarnings: 3, action: 'kick' }] },
    leveling: {
      enabled: true,
      levelUpMessage: { ...EMPTY_MESSAGE, content: '{user} reached level {level}.' },
      roleRewards: [{ level: 5, roleId: '600000000000000001' }],
    },
    rolemenu: { enabled: false, menus: [{ id: 'colours' }] },
    serverlog: { enabled: true, events: { 'member.join': { enabled: true } } },
    automod: { enabled: true, blockedWords: ['scam'] },
    permissions: { enabled: true, overrides: { ban: ['600000000000000001'] } },
  };

  for (const [id, config] of Object.entries(SAVED)) {
    test(`${id} saves back exactly what it loaded when nobody touches a panel`, () => {
      expect(applyPanels(id, config, initialPanelValues(id, config))).toEqual(config);
    });
  }

  test('a panel key absent from the stored config is written as its empty value, not undefined', () => {
    const saved = applyPanels('cases', { enabled: true }, initialPanelValues('cases', {}));

    expect(saved).toEqual({ enabled: true, escalationLadder: [] });
    expect(Object.values(saved)).not.toContain(undefined);
  });
});

describe('what each panel does with the props the registry hands it', () => {
  test('the escalation ladder renders the rungs it is given', () => {
    const html = renderPanel('cases', panelsFor('cases')[0] as PanelEntry, [
      { atWarnings: 3, action: 'timeout', duration: '1h' },
    ]);

    expect(html).toContain('value="3"');
  });

  test('role rewards is handed the guild’s roles, not just its value', () => {
    const html = renderPanel('leveling', panelsFor('leveling')[1] as PanelEntry, [
      { level: 5, roleId: '600000000000000001' },
      { level: 10, roleId: '600000000000000002' },
    ]);

    expect(html).toContain('<span class="picker-value">Moderator</span>');
    expect(html).toContain('<span class="picker-value">Member</span>');
    expect(html).toContain('pick-dot');
  });

  test('role menus is handed both the roles and the channels', () => {
    const html = renderPanel('rolemenu', panelsFor('rolemenu')[0] as PanelEntry, [
      {
        id: 'colours',
        channelId: '500000000000000001',
        kind: 'button',
        mode: 'toggle',
        bindings: [{ key: 'choice-1', roleId: '600000000000000001' }],
      },
    ]);

    expect(html).toContain('data-icon="hash"');
    expect(html).toContain('<span class="picker-value">general</span>');
    expect(html).toContain('<span class="picker-value">Moderator</span>');
  });

  test('the automod readout is derived from the live form, so it ignores its stored value', () => {
    const entry = panelsFor('automod')[0] as PanelEntry;

    expect(renderPanel('automod', entry, undefined)).toContain('Blocked words and patterns');
    expect(renderPanel('automod', entry, undefined)).toBe(
      renderPanel('automod', entry, [{ nonsense: true }]),
    );
  });

  test('the log matrix reads its routing from the live form rather than the saved config', () => {
    const entry = panelsFor('serverlog')[0] as PanelEntry;
    const Panel = entry.Panel;

    function withLive(liveConfig: Record<string, unknown>): string {
      return renderToStaticMarkup(
        <Panel
          value={{}}
          onChange={() => undefined}
          channels={CHANNELS}
          roles={ROLES}
          liveConfig={liveConfig}
          guildId="900000000000000001"
        />,
      );
    }

    // '#general' alone proves nothing — the channel picker lists every channel either way.
    expect(withLive({})).toContain('nowhere');
    expect(withLive({ defaultChannelId: '500000000000000001' })).not.toContain('nowhere');
  });

  test('the log matrix routes a category to its own channel over the default', () => {
    const entry = panelsFor('serverlog')[0] as PanelEntry;
    const Panel = entry.Panel;

    function withLive(liveConfig: Record<string, unknown>): string {
      return renderToStaticMarkup(
        <Panel
          value={{}}
          onChange={() => undefined}
          channels={CHANNELS}
          roles={ROLES}
          liveConfig={liveConfig}
          guildId="900000000000000001"
        />,
      );
    }

    const base = { defaultChannelId: '500000000000000001', categories: { members: true } };

    expect(withLive({ ...base, categoryChannels: { members: '500000000000000002' } })).not.toBe(
      withLive({ ...base, categoryChannels: {} }),
    );
  });
});

describe('the welcome module, whose two greetings are each their own message', () => {
  test('each greeting is edited under its own config key', () => {
    expect(panelsFor('welcome').map((entry) => [entry.key, entry.title])).toEqual([
      ['welcomeMessage', 'Welcome message'],
      ['goodbyeMessage', 'Goodbye message'],
      [null, 'Card preview'],
    ]);
  });

  // The bug this closes: a greeting stored as a bare string reaches the panel unparsed, and a
  // builder that could not read it would hand an empty message back to the next save.
  test('a greeting still stored as a bare string renders its text', () => {
    const html = renderPanel('welcome', panelsFor('welcome')[0] as PanelEntry, 'Welcome, {user}!');

    expect(html).toContain('Welcome, {user}!');
  });

  test('both greetings survive a load and save nobody touched', () => {
    const config = {
      enabled: true,
      welcomeMessage: 'Welcome to {server}!',
      goodbyeMessage: 'Bye {username}.',
    };

    expect(applyPanels('welcome', config, initialPanelValues('welcome', config))).toEqual(config);
  });
});

describe('the honeypot, whose delete window is stored in seconds and edited in days', () => {
  const editor = () => panelsFor('honeypot')[0] as PanelEntry;

  test('a seven-day window is offered as 7, never as 604800', () => {
    const html = renderPanel('honeypot', editor(), [HONEYPOT_ROW]);

    expect(html).toContain('value="7"');
    expect(html).not.toContain('604800');
  });

  test('the row says in words how far back the deletion reaches', () => {
    expect(renderPanel('honeypot', editor(), [HONEYPOT_ROW])).toContain('the last 7 days');
  });

  test('the timeout length is offered only for the action that reads it', () => {
    const softban = renderPanel('honeypot', editor(), [HONEYPOT_ROW]);
    const timeout = renderPanel('honeypot', editor(), [{ ...HONEYPOT_ROW, action: 'timeout' }]);

    expect(softban).not.toContain('Timed out for');
    expect(timeout).toContain('Timed out for');
  });

  // Arming is the dangerous half. Nothing may be armed by the first click, so the confirmation
  // copy must be absent until somebody asks for it.
  test('no arming confirmation is shown until somebody asks to arm one', () => {
    expect(renderPanel('honeypot', editor(), [HONEYPOT_ROW])).not.toContain('Arm it');
  });

  test('the notice panel offers one control per saved honeypot and names what posting costs', () => {
    const html = renderPanel('honeypot', panelsFor('honeypot')[1] as PanelEntry, undefined);

    expect(html).toContain('Post the notice');
    expect(html).toContain('#general');
    expect(html).toContain('be removed from the server and let straight back in');
  });
});

describe('the values a module page holds for its panels', () => {
  test('every keyed panel is seeded, so saving cannot blank a key nobody touched', () => {
    for (const id of Object.keys(MODULE_PANELS)) {
      const keyed = panelsFor(id)
        .flatMap((entry) => (entry.key === null ? [] : [entry.key]))
        .sort();

      expect(`${id}: ${Object.keys(initialPanelValues(id, {})).sort().join()}`).toBe(
        `${id}: ${keyed.join()}`,
      );
    }
  });

  test('the key each panel is rendered under is unique within its module', () => {
    for (const [id, spec] of Object.entries(MODULE_PANELS)) {
      const rendered = spec.panels.map((entry) => entry.key ?? entry.title);

      expect(`${id}: ${new Set(rendered).size}`).toBe(`${id}: ${rendered.length}`);
    }
  });
});

const MODULES_DIR = join(import.meta.dir, '..', '..', '..', 'packages', 'modules');

function barrelsCarryingDiscordJs(): Set<string> {
  const tainted = new Set<string>();

  for (const entry of readdirSync(MODULES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const manifest = JSON.parse(
      readFileSync(join(MODULES_DIR, entry.name, 'package.json'), 'utf8'),
    ) as { name: string; dependencies?: Record<string, string> };

    if (manifest.dependencies?.['discord.js'] !== undefined) tainted.add(manifest.name);
  }

  return tainted;
}

function bareModuleImports(source: string): string[] {
  return [...source.matchAll(/from '(@proton\/module-[^']+)'/g)]
    .map((match) => match[1] ?? '')
    .filter((specifier) => !specifier.slice('@proton/'.length).includes('/'));
}

describe('how this test reaches the module config schemas it checks panel keys against', () => {
  const tainted = barrelsCarryingDiscordJs();

  test('the modules behind these panels really do carry discord.js in their barrel', () => {
    expect([...tainted].sort()).toContain('@proton/module-leveling');
    expect([...tainted].sort()).toContain('@proton/module-rolemenu');
  });

  // Every schema here is reachable from a barrel too, and client-bundle.test.ts scans only src/.
  test('no schema is imported through a barrel that carries discord.js', () => {
    const source = readFileSync(join(import.meta.dir, 'panel-registry.test.tsx'), 'utf8');
    const offenders = bareModuleImports(source).filter((specifier) => tainted.has(specifier));

    expect(offenders).toEqual([]);
  });

  test('the registry itself reaches every module the same way', () => {
    const registry = readFileSync(
      join(import.meta.dir, '..', 'src', 'components', 'panels', 'registry.ts'),
      'utf8',
    );
    const panels = readFileSync(
      join(import.meta.dir, '..', 'src', 'components', 'panels', 'panels.tsx'),
      'utf8',
    );

    expect(bareModuleImports(registry).filter((s) => tainted.has(s))).toEqual([]);
    expect(bareModuleImports(panels).filter((s) => tainted.has(s))).toEqual([]);
  });
});
