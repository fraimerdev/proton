import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMPTY_MESSAGE } from '@proton/core';
import { appealPanelsSchema, appealsConfigSchema } from '@proton/module-appeals/config';
import { casesConfigSchema, escalationLadderSchema } from '@proton/module-cases';
import { countersConfigSchema, countersListSchema } from '@proton/module-counters/config';
import {
  DEFAULT_DM_MESSAGE,
  DEFAULT_NOTICE_MESSAGE,
  type HoneypotAction,
  type HoneypotChannel,
  honeypotChannelsSchema,
  honeypotConfigSchema,
  honeypotLayoutSchema,
} from '@proton/module-honeypot/config';
import {
  levelingConfigSchema,
  levelUpMessageSchema,
  roleRewardsSchema,
} from '@proton/module-leveling/config';
import {
  messagesConfigSchema,
  savedComponentsSchema,
  templatesSchema,
} from '@proton/module-messages/config';
import { rolemenuConfigSchema, rolemenuMenusSchema } from '@proton/module-rolemenu/config';
import { serverlogConfigSchema } from '@proton/module-serverlog/config';
import { tempVcConfigSchema, tempVcHubsSchema } from '@proton/module-tempvc/config';
import {
  ticketPanelsSchema,
  ticketResponsesSchema,
  ticketsConfigSchema,
  ticketTypesSchema,
} from '@proton/module-tickets/config';
import { greetingMessageSchema, welcomeConfigSchema } from '@proton/module-welcome/config';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { z } from 'zod';
import { EscalationLadderEditor } from '../src/components/cases/escalation-ladder.tsx';
import { HoneypotChannelsEditor } from '../src/components/honeypot/channels.tsx';
import { RoleRewardsEditor } from '../src/components/leveling/role-rewards.tsx';
import { MODULE_ROUTE_IDS } from '../src/components/module/paths.ts';
import { RolemenuEditor } from '../src/components/rolemenu/menus.tsx';
import { GreetingEditor } from '../src/components/welcome/greeting.tsx';

/**
 * There is no panel registry any more: each module's route file imports the editors it needs and
 * hands them their props by hand. The invariants the registry used to carry are still real, so
 * they are checked against the route files themselves — the keys an editor is bound to, the empty
 * value it falls back to, the schema the save gate reads, and the preload the loader needs.
 */
const ROUTES = join(import.meta.dir, '..', 'src', 'routes', 'dashboard', '$guildId');

function routeSource(moduleId: string): string {
  return readFileSync(join(ROUTES, `${moduleId}.tsx`), 'utf8');
}

function routedModules(): string[] {
  return readdirSync(ROUTES)
    .filter((name) => name.endsWith('.tsx') && name !== 'index.tsx')
    .map((name) => name.replace(/\.tsx$/, ''));
}

/**
 * Editors declared at module scope, which the route mounts inside its settings form. The `View:`
 * of a browse tab is deliberately not one of these: the loader preloads a view through the entry
 * it resolved, and a view declared inline is indented, so anchoring to the start of the line is
 * what separates the two.
 */
function lazyEditors(source: string): string[] {
  return [...source.matchAll(/^const (\w+) = lazyRouteComponent\(/gm)].map(
    (match) => match[1] ?? '',
  );
}

function preloadedEditors(source: string): string[] {
  const declared = source.match(/preload:\s*\[([^\]]*)\]/);

  return (declared?.[1] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

function readKeys(source: string): string[] {
  return [
    ...new Set([...source.matchAll(/form\.value\('([\w.]+)'/g)].map((m) => m[1] ?? '')),
  ].sort();
}

function writtenKeys(source: string): string[] {
  return [...new Set([...source.matchAll(/form\.set\('([\w.]+)'/g)].map((m) => m[1] ?? ''))].sort();
}

interface Fallback {
  key: string;
  literal: string;
  value: unknown;
}

/**
 * The value an editor is handed when the stored config has nothing under its key — what
 * `initialPanelValues` used to seed from the registry's `emptyValue`, now written at the call
 * site. Only literals this can decode are returned, and the test below that every written key has
 * one is what stops a seed it cannot read from passing as a seed that is not there.
 */
function fallbacks(source: string): Fallback[] {
  const found: Fallback[] = [];

  for (const match of source.matchAll(/form\.value\('([\w.]+)',\s*([^)]*?)\)/g)) {
    const key = match[1] ?? '';
    const literal = (match[2] ?? '').trim();

    // An explicit `undefined` is a fallback like any other: an optional scalar has no empty value
    // to stand in for "nothing chosen", and inventing one would store a choice nobody made.
    if (literal === 'undefined') found.push({ key, literal, value: undefined });
    else if (literal === '[]') found.push({ key, literal, value: [] });
    else if (literal === '{}') found.push({ key, literal, value: {} });
    else if (literal === 'EMPTY_MESSAGE') found.push({ key, literal, value: EMPTY_MESSAGE });
    else if (literal === 'DEFAULT_NOTICE_MESSAGE')
      found.push({ key, literal, value: DEFAULT_NOTICE_MESSAGE });
    else if (literal === 'DEFAULT_DM_MESSAGE')
      found.push({ key, literal, value: DEFAULT_DM_MESSAGE });
    // Numeric separators included: 604_800 is a fallback like any other, and skipping it here
    // would report a key that has one as having none.
    else if (/^-?[\d_]+$/.test(literal))
      found.push({ key, literal, value: Number(literal.replaceAll('_', '')) });
    else if (/^'[^']*'$/.test(literal)) found.push({ key, literal, value: literal.slice(1, -1) });
  }

  return found;
}

interface Gate {
  key: string;
  title: string;
  schema: string;
}

function gates(source: string): Gate[] {
  return [...source.matchAll(/usePanelSchema\(\s*'([^']+)',\s*'([^']+)',\s*(\w+),/g)].map(
    (match) => ({ key: match[1] ?? '', title: match[2] ?? '', schema: match[3] ?? '' }),
  );
}

const CONFIG_SCHEMAS: Record<string, z.ZodObject> = {
  appeals: appealsConfigSchema,
  cases: casesConfigSchema,
  counters: countersConfigSchema,
  honeypot: honeypotConfigSchema,
  leveling: levelingConfigSchema,
  messages: messagesConfigSchema,
  rolemenu: rolemenuConfigSchema,
  serverlog: serverlogConfigSchema,
  tempvc: tempVcConfigSchema,
  tickets: ticketsConfigSchema,
  welcome: welcomeConfigSchema,
};

/** The schemas the save gate is handed, by the name the route file calls them. */
const GATE_SCHEMAS: Record<string, { safeParse: (value: unknown) => { success: boolean } }> = {
  appealPanelsSchema,
  countersListSchema,
  escalationLadderSchema,
  greetingMessageSchema,
  levelUpMessageSchema,
  savedComponentsSchema,
  templatesSchema,
  honeypotChannelsSchema,
  honeypotLayoutSchema,
  roleRewardsSchema,
  rolemenuMenusSchema,
  tempVcHubsSchema,
  ticketTypesSchema,
  ticketPanelsSchema,
  ticketResponsesSchema,
};

const CHANNELS = [
  { id: '500000000000000001', name: 'general', type: 0 },
  { id: '500000000000000002', name: 'voice', type: 2 },
];

const ROLES = [
  { id: '600000000000000001', name: 'Moderator', position: 5 },
  { id: '600000000000000002', name: 'Member', position: 1 },
];

const HONEYPOT_ROW: Partial<HoneypotChannel> = {
  channelId: '500000000000000001',
  enabled: true,
};

// Wrapped, because in the app every editor renders inside the shell's provider and one of them
// reads the query client to refresh itself after an upload.
function render(editor: ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{editor}</QueryClientProvider>,
  );
}

describe('the six modules migrated off the if-chain still edit exactly what they did', () => {
  // Scoped to the six on purpose: this guards the migration, so a module added afterwards must
  // not have to be listed here to keep it passing.
  test('each writes the same config keys through its own editors', () => {
    const migrated = ['cases', 'leveling', 'rolemenu', 'automod', 'serverlog', 'permissions'];

    const written = Object.fromEntries(migrated.map((id) => [id, writtenKeys(routeSource(id))]));

    expect(written).toEqual({
      cases: ['escalationLadder'],
      leveling: ['levelUpMessage', 'roleRewards'],
      rolemenu: ['menus'],

      // Derived, both of them: automod's enforcement readout is built from the live form and
      // permissions' overrides go through the generic role-token field, so neither writes a key
      // of its own.
      automod: [],
      permissions: [],

      serverlog: ['events'],
    });
  });
});

/**
 * What the registry's lazy `Panel` plus the loader's preload used to guarantee between them: the
 * editor's chunk is asked for beside the config, not after it, so a module with a bespoke editor
 * never opens on an empty section while its code is still in flight.
 */
describe('a route that lazily imports an editor preloads it', () => {
  const routes = routedModules();

  test('some route really does declare one, or everything below proves nothing', () => {
    expect(routes.filter((id) => lazyEditors(routeSource(id)).length > 0).length).toBeGreaterThan(
      0,
    );
  });

  test('every editor a route declares is handed to moduleRoute', () => {
    const missing: string[] = [];

    for (const id of routes) {
      const source = routeSource(id);
      const preloaded = new Set(preloadedEditors(source));

      for (const editor of lazyEditors(source)) {
        if (!preloaded.has(editor)) missing.push(`${id}.tsx: ${editor}`);
      }
    }

    expect(missing).toEqual([]);
  });

  // The other direction: a name in `preload` that is not one of this file's lazy editors has no
  // `.preload` to call, so the loader awaits nothing and the promise of a warm chunk is a lie.
  test('nothing is preloaded that is not one of that route’s lazy editors', () => {
    const strays: string[] = [];

    for (const id of routes) {
      const source = routeSource(id);
      const declared = new Set(lazyEditors(source));

      for (const name of preloadedEditors(source)) {
        if (!declared.has(name)) strays.push(`${id}.tsx: ${name}`);
      }
    }

    expect(strays).toEqual([]);
  });
});

describe('the config keys a route’s editors read and write', () => {
  const routes = routedModules().filter((id) => Object.hasOwn(CONFIG_SCHEMAS, id));

  test('every module that mounts a bespoke editor has a schema to check it against', () => {
    const unchecked = routedModules().filter(
      (id) =>
        !Object.hasOwn(CONFIG_SCHEMAS, id) &&
        (lazyEditors(routeSource(id)).length > 0 || gates(routeSource(id)).length > 0),
    );

    expect(unchecked).toEqual([]);
  });

  test('every key an editor is bound to is a real key of that module’s config schema', () => {
    const unknown: string[] = [];

    for (const id of routes) {
      const shape = Object.keys(CONFIG_SCHEMAS[id]?.shape ?? {});
      const source = routeSource(id);

      for (const key of [...readKeys(source), ...writtenKeys(source)]) {
        // The root, not the whole path: a route is free to read `card.accent` out of a config
        // whose schema declares `card`.
        const root = key.split('.')[0] ?? '';
        if (!shape.includes(root)) unknown.push(`${id}.${key}`);
      }
    }

    expect(unknown).toEqual([]);
  });

  // Two editors writing one key would each save over the other, and the second mount would win by
  // nothing better than render order.
  test('no two editors in a route write the same key', () => {
    for (const id of routes) {
      const written = [...routeSource(id).matchAll(/form\.set\('([\w.]+)'/g)].map(
        (m) => m[1] ?? '',
      );

      expect(`${id}: ${new Set(written).size}`).toBe(`${id}: ${written.length}`);
    }
  });
});

/**
 * The registry used to seed a page from each panel's `emptyValue`, so a key nobody touched could
 * not be saved back as undefined. The seed now lives at the call site, as the fallback argument to
 * `form.value` — and it is only as good as its shape.
 */
describe('the value an editor is handed when its key is absent', () => {
  const routes = routedModules().filter((id) => Object.hasOwn(CONFIG_SCHEMAS, id));

  test('every fallback is a value that key’s own schema accepts', () => {
    const rejected: string[] = [];

    for (const id of routes) {
      const shape = CONFIG_SCHEMAS[id]?.shape ?? {};

      for (const { key, literal, value } of fallbacks(routeSource(id))) {
        const field = shape[key.split('.')[0] ?? ''];
        if (field === undefined) continue;

        if (!field.safeParse(value).success) rejected.push(`${id}.${key} = ${literal}`);
      }
    }

    expect(rejected).toEqual([]);
  });

  test('no fallback is left out, so nothing reaches an editor as undefined', () => {
    const missing: string[] = [];

    for (const id of routedModules()) {
      const source = routeSource(id);
      const decoded = new Set(fallbacks(source).map((entry) => entry.key));

      // Only the keys an editor is bound to: a plain field reads its own default from its input.
      for (const key of writtenKeys(source)) {
        if (!decoded.has(key)) missing.push(`${id}.${key}`);
      }
    }

    expect(missing).toEqual([]);
  });

  // The shapes the old registry seeded, spelled out: a list, a record and a message. They are what
  // makes `{}` a load and a save that changes nothing rather than a blanked key.
  test('the seeds the migrated modules kept are still the ones they had', () => {
    const seeds = Object.fromEntries(
      ['cases', 'serverlog', 'leveling', 'rolemenu'].map((id) => [
        id,
        Object.fromEntries(fallbacks(routeSource(id)).map((entry) => [entry.key, entry.literal])),
      ]),
    );

    expect(seeds).toEqual({
      cases: { escalationLadder: '[]' },
      serverlog: { events: '{}' },
      leveling: {
        xpPerMessageMin: '15',
        xpPerMessageMax: '25',
        levelUpMessage: 'EMPTY_MESSAGE',
        roleRewards: '[]',
      },
      rolemenu: { menus: '[]' },
    });
  });
});

/**
 * Save is gated on every editor, not the one on screen: each mounts `usePanelSchema`, which reports
 * its own key so a module with sub-pages cannot save a list that the page you are not looking at
 * knows is broken.
 */
describe('the schema each editor reports against', () => {
  const routes = routedModules();

  test('at least one route gates a value, or everything below proves nothing', () => {
    expect(routes.flatMap((id) => gates(routeSource(id))).length).toBeGreaterThan(0);
  });

  test('every gate names a key of its module’s config schema', () => {
    for (const id of routes) {
      const shape = Object.keys(CONFIG_SCHEMAS[id]?.shape ?? {});

      for (const gate of gates(routeSource(id))) {
        expect(`${id}: ${gate.key} in schema: ${shape.includes(gate.key)}`).toBe(
          `${id}: ${gate.key} in schema: true`,
        );
      }
    }
  });

  test('every gate is reported under the title its card carries', () => {
    for (const id of routes) {
      for (const gate of gates(routeSource(id))) {
        expect(`${id}.${gate.key}: ${gate.title.length > 0}`).toBe(`${id}.${gate.key}: true`);
      }
    }
  });

  // Not `{}` — some of these schemas treat an absent value as valid, which is their business. A
  // number is not a list of anything, so every schema the gate is handed must reject it.
  test('every gated schema rejects a value no editor could have produced', () => {
    const checked: string[] = [];

    for (const id of routes) {
      for (const gate of gates(routeSource(id))) {
        const schema = GATE_SCHEMAS[gate.schema];

        expect(`${id}.${gate.key}: ${gate.schema} known here: ${schema !== undefined}`).toBe(
          `${id}.${gate.key}: ${gate.schema} known here: true`,
        );

        checked.push(`${id}.${gate.key}`);
        expect(`${id}.${gate.key}: ${schema?.safeParse(0).success}`).toBe(
          `${id}.${gate.key}: false`,
        );
      }
    }

    expect(checked.length).toBeGreaterThan(0);
  });
});

describe('what each editor does with the props its route hands it', () => {
  test('the escalation ladder renders the rungs it is given', () => {
    const html = render(
      <EscalationLadderEditor
        rungs={[{ atWarnings: 3, action: 'timeout', duration: '1h' }]}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain('value="3"');
  });

  test('role rewards is handed the guild’s roles, not just its value', () => {
    const html = render(
      <RoleRewardsEditor
        rewards={[
          { level: 5, roleId: '600000000000000001' },
          { level: 10, roleId: '600000000000000002' },
        ]}
        roles={ROLES}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain('<span class="picker-value">Moderator</span>');
    expect(html).toContain('<span class="picker-value">Member</span>');
    expect(html).toContain('pick-dot');
  });

  test('role menus is handed both the roles and the channels', () => {
    const html = render(
      <RolemenuEditor
        menus={[
          {
            id: 'colours',
            channelId: '500000000000000001',
            kind: 'button',
            mode: 'toggle',
            bindings: [{ key: 'choice-1', roleId: '600000000000000001' }],
          },
        ]}
        roles={ROLES}
        channels={CHANNELS}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain('data-icon="hash"');
    expect(html).toContain('<span class="picker-value">general</span>');
    expect(html).toContain('<span class="picker-value">Moderator</span>');
  });
});

describe('the welcome module, whose two greetings are each their own message', () => {
  test('each greeting is edited under its own config key', () => {
    expect(writtenKeys(routeSource('welcome'))).toEqual(['goodbyeMessage', 'welcomeMessage']);
  });

  // The bug this closes: a greeting stored as a bare string reaches the editor unparsed, and a
  // builder that could not read it would hand an empty message back to the next save.
  test('a greeting still stored as a bare string renders its text', () => {
    const html = render(
      <GreetingEditor
        message="Welcome, {user}!"
        onChange={() => undefined}
        channels={CHANNELS}
        roles={ROLES}
        description="Posted in the welcome channel when somebody joins."
      />,
    );

    expect(html).toContain('Welcome, {user}!');
  });
});

describe('the honeypot channel list, which now carries only the channel and whether it is armed', () => {
  function honeypot(
    rows: readonly Partial<HoneypotChannel>[],
    action: HoneypotAction = 'softban',
    deleteMessageSeconds = 604_800,
  ): string {
    return render(
      <HoneypotChannelsEditor
        honeypots={rows}
        channels={CHANNELS}
        tier="free"
        action={action}
        deleteMessageSeconds={deleteMessageSeconds}
        onChange={() => undefined}
      />,
    );
  }

  // The action, the window and the timeout moved to the module. A row offering them again would
  // be offering a setting that no longer exists.
  test('offers no per-row action, window or timeout', () => {
    const html = honeypot([HONEYPOT_ROW]);

    expect(html).not.toContain('What happens to them');
    expect(html).not.toContain('Timed out for');
    expect(html).not.toContain('Delete their messages');
  });

  test('offers the channel and whether it is armed, and nothing else', () => {
    const html = honeypot([HONEYPOT_ROW]);

    expect(html).toContain('Channel');
    expect(html).toContain('Armed');
  });

  // Arming is the dangerous half. Nothing may be armed by the first click, so the confirmation
  // copy must be absent until somebody asks for it.
  test('no arming confirmation is shown until somebody asks to arm one', () => {
    expect(honeypot([HONEYPOT_ROW])).not.toContain('Arm it');
  });

  test('the empty state says nothing is trapped yet', () => {
    expect(honeypot([])).toContain('Nothing is trapped');
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

describe('how this test reaches the module config schemas it checks keys against', () => {
  const tainted = barrelsCarryingDiscordJs();

  test('the modules behind these editors really do carry discord.js in their barrel', () => {
    expect([...tainted].sort()).toContain('@proton/module-leveling');
    expect([...tainted].sort()).toContain('@proton/module-rolemenu');
  });

  // Every schema here is reachable from a barrel too, and client-bundle.test.ts scans only src/.
  // The route files it used to also check are inside src/, so that scan now covers them.
  test('no schema is imported through a barrel that carries discord.js', () => {
    const source = readFileSync(join(import.meta.dir, 'panel-registry.test.tsx'), 'utf8');
    const offenders = bareModuleImports(source).filter((specifier) => tainted.has(specifier));

    expect(offenders).toEqual([]);
  });
});

describe('the route files this test reads', () => {
  // A route file renamed or removed without this test noticing would quietly stop checking that
  // module, and every scan above would still pass.
  test('every routed module has a file here, and every file is a routed module', () => {
    expect(routedModules().sort()).toEqual([...MODULE_ROUTE_IDS].sort());
  });
});
