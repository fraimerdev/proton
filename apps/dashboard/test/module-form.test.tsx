import { afterAll, describe, expect, mock, test } from 'bun:test';
import type { ModuleConfigView } from '@proton/core';
import { useRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ModuleForm } from '../src/components/module/form.ts';
import { queryKeys } from '../src/lib/query-keys.ts';

const GUILD = '900000000000000001';
const MODULE = 'verification';

/**
 * The config a real module page reads. Only a handful of these keys are bound to a control on any
 * one page — `domains`, `embed.footer.icon` and `legacy` stand in for the settings some other page,
 * or no page at all, owns. Every assertion below is really the same question: after this page saves,
 * are they still there?
 */
const STORED = {
  enabled: true,
  mode: 'captcha',
  quarantineRoleId: '600000000000000001',
  message: 'Welcome, {user}',
  domains: ['a.example', 'b.example'],
  captcha: { length: 6, attempts: 3, expiry: 300 },
  embed: { colour: '#5865f2', footer: { text: 'Proton', icon: null } },
  legacy: { migratedAt: '2026-01-01T00:00:00.000Z' },
};

function view(config: Record<string, unknown>): ModuleConfigView {
  return {
    moduleId: MODULE,
    enabled: true,
    config: config as ModuleConfigView['config'],
    schemaVersion: 3,
    migrated: false,
    tier: 'free',
  };
}

// Whatever `useSuspenseQuery` is handed, keyed the way the real cache would key it.
const CACHE = new Map<string, unknown>([
  [
    JSON.stringify(queryKeys.modules(GUILD)),
    {
      modules: [
        {
          id: MODULE,
          name: 'Verification',
          category: 'security',
          fields: [],
          commands: [],
          enabled: true,
          dashboard: null,
          status: null,
        },
      ],
    },
  ],
  [JSON.stringify(queryKeys.moduleConfig(GUILD, MODULE)), view(structuredClone(STORED))],
  [JSON.stringify(queryKeys.channels(GUILD)), []],
  [JSON.stringify(queryKeys.roles(GUILD)), []],
  [JSON.stringify(queryKeys.session()), { guilds: [{ id: GUILD, name: 'Test Guild' }] }],
]);

interface Submission {
  guildId: string;
  moduleId: string;
  config: Record<string, unknown>;
}

const submissions: Submission[] = [];

const cacheWrites: { key: unknown; data: unknown }[] = [];
const invalidations: unknown[] = [];

/**
 * Module mocks are process-wide and outlive this file, and `bun test` runs every dashboard suite in
 * one process. So each mock below re-exports the real module and overrides only the few names this
 * hook reaches for, and the real namespaces go back on the registry once these tests are done —
 * otherwise the next suite to import react-query finds a module with four exports in it.
 */
const reactQuery = await import('@tanstack/react-query');
const reactRouter = await import('@tanstack/react-router');

afterAll(() => {
  mock.module('@tanstack/react-query', () => reactQuery);
  mock.module('@tanstack/react-router', () => reactRouter);
});

// The one mock with no real module behind it: importing it validates the dashboard's env and throws.
mock.module('../src/server/modules.ts', () => ({
  listGuilds: () => Promise.resolve(CACHE.get(JSON.stringify(queryKeys.session()))),
  listModules: () => Promise.resolve(CACHE.get(JSON.stringify(queryKeys.modules(GUILD)))),
  getModuleConfig: () => Promise.resolve(undefined),
  getGuildOverview: () => Promise.resolve(undefined),
  getGuildChannels: () => Promise.resolve([]),
  getGuildRoles: () => Promise.resolve([]),
  searchCases: () => Promise.resolve(undefined),
  searchLeaderboard: () => Promise.resolve(undefined),
  searchTags: () => Promise.resolve(undefined),
  searchTickets: () => Promise.resolve(undefined),

  updateModuleConfig: ({ data }: { data: Submission }) => {
    submissions.push(data);
    return Promise.resolve({ before: view(STORED), after: view(data.config) });
  },
}));

mock.module('@tanstack/react-query', () => ({
  ...reactQuery,

  useSuspenseQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    const key = JSON.stringify(queryKey);
    if (!CACHE.has(key)) throw new Error(`nothing seeded for ${key}`);

    return { data: CACHE.get(key) };
  },

  useMutation: (options: {
    mutationFn: (variables: Record<string, unknown>) => Promise<unknown>;
    onSuccess?: (result: unknown) => void;
  }) => ({
    mutate: (variables: Record<string, unknown>) => {
      void options.mutationFn(variables).then((result) => options.onSuccess?.(result));
    },
    isPending: false,
    error: null,
    reset: () => undefined,
  }),

  useQueryClient: () => ({
    setQueryData: (key: unknown, data: unknown) => cacheWrites.push({ key, data }),
    invalidateQueries: (filters: unknown) => {
      invalidations.push(filters);
      return Promise.resolve();
    },
  }),
}));

// useBlocker wants a router above it; nothing here navigates, so it always answers "not blocked".
mock.module('@tanstack/react-router', () => ({
  ...reactRouter,
  useBlocker: () => ({ status: 'idle', reset: () => undefined, proceed: () => undefined }),
}));

const { useModuleForm } = await import('../src/components/module/form.ts');

type Edit = readonly [string, unknown];

/**
 * A whole render pass of one module page, with `edits` standing in for the controls the reader
 * touched. They are dispatched from inside the render, which is a render-phase update: React
 * re-invokes the component with the new state before the pass finishes, so the form handed back is
 * the one the page would be showing after those edits — no DOM and no effects required.
 */
function drive(
  edits: readonly Edit[] = [],
  options: { normalise?: (config: Record<string, unknown>) => Record<string, unknown> } = {},
): ModuleForm {
  let captured: ModuleForm | undefined;

  function Probe(): null {
    const form = useModuleForm(GUILD, MODULE, false, options.normalise);
    const applied = useRef(false);

    if (!applied.current) {
      applied.current = true;
      for (const [path, value] of edits) form.set(path, value);
    }

    captured = form;
    return null;
  }

  renderToStaticMarkup(<Probe />);
  if (!captured) throw new Error('the probe never rendered');

  return captured;
}

function submit(form: ModuleForm): Record<string, unknown> {
  const before = submissions.length;
  form.save();

  const sent = submissions[before];
  if (!sent) throw new Error('save() reached no server function');

  return sent.config;
}

// The mutation's onSuccess is a microtask behind the write it answers.
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// A guard for every test below: they all assert that some stored key survived a save, and a harness
// that quietly rendered against an empty config would pass all of them.
describe('the harness', () => {
  test('renders the form against the seeded config', () => {
    const form = drive();

    expect(form.config).toEqual(STORED);
    expect(form.moduleId).toBe(MODULE);
    expect(form.guildName).toBe('Test Guild');
  });

  test('an edit made during the pass is visible in the form it hands back', () => {
    expect(drive([['message', 'Hello, {user}']]).value('message')).toBe('Hello, {user}');
  });
});

/**
 * The property the whole hook exists for. The form holds edited paths, never a copy of the config,
 * and a save writes those paths over what is stored — so a page that renders four controls cannot
 * post back a config missing the forty settings it never drew. The generated form this replaced
 * built its submission out of the descriptors it had been handed, which is exactly the shape that
 * drops a key when the page and the schema disagree.
 */
describe('a save carries the settings this page never rendered', () => {
  test('a page that changed nothing submits the stored config verbatim', () => {
    expect(submit(drive())).toEqual(STORED);
  });

  test('one edited path leaves every other stored key untouched', () => {
    const sent = submit(drive([['message', 'Hello, {user}']]));

    expect(sent).toEqual({ ...STORED, message: 'Hello, {user}' });

    // Named again on their own: a toEqual against a spread of the same fixture would still pass if
    // both sides had lost the key.
    expect(sent.domains).toEqual(['a.example', 'b.example']);
    expect(sent.legacy).toEqual({ migratedAt: '2026-01-01T00:00:00.000Z' });
    expect(sent.captcha).toEqual({ length: 6, attempts: 3, expiry: 300 });
  });

  test('several edits across several branches still only move those branches', () => {
    const sent = submit(
      drive([
        ['mode', 'button'],
        ['captcha.attempts', 5],
        ['embed.colour', '#ff0000'],
      ]),
    );

    expect(sent).toEqual({
      ...STORED,
      mode: 'button',
      captcha: { length: 6, attempts: 5, expiry: 300 },
      embed: { colour: '#ff0000', footer: { text: 'Proton', icon: null } },
    });
  });

  test('a path with no stored value is added rather than replacing the config', () => {
    const sent = submit(drive([['welcomeDm.body', 'Hi']]));

    expect(sent).toEqual({ ...STORED, welcomeDm: { body: 'Hi' } });
  });

  test('the stored config the cache holds is not itself edited', () => {
    const form = drive([['message', 'Hello, {user}']]);
    submit(form);

    expect(form.config).toEqual(STORED);
    expect(form.live).not.toBe(form.config);
    expect(CACHE.get(JSON.stringify(queryKeys.moduleConfig(GUILD, MODULE)))).toEqual(view(STORED));
  });

  // The one narrowing the write is allowed: permissions posts a smaller shape than it edits.
  test('a normalise hook shapes the submission and nothing else', () => {
    const form = drive([['message', 'Hello, {user}']], {
      normalise: ({ legacy: _dropped, ...rest }) => rest,
    });

    const sent = submit(form);

    expect(sent.legacy).toBeUndefined();
    expect(sent.message).toBe('Hello, {user}');
    expect(form.live.legacy).toEqual(STORED.legacy);
  });
});

describe('a nested path merges with its siblings', () => {
  test('two levels down, the branch keeps the keys the page did not touch', () => {
    const sent = submit(drive([['embed.footer.text', 'Verified by Proton']]));

    expect(sent.embed).toEqual({
      colour: '#5865f2',
      footer: { text: 'Verified by Proton', icon: null },
    });
  });

  test('two edits into one branch both land', () => {
    const sent = submit(
      drive([
        ['embed.footer.text', 'Verified by Proton'],
        ['embed.footer.icon', 'https://cdn.example/i.png'],
      ]),
    );

    expect(sent.embed).toEqual({
      colour: '#5865f2',
      footer: { text: 'Verified by Proton', icon: 'https://cdn.example/i.png' },
    });
  });

  test('an edit to one branch does not disturb another', () => {
    const sent = submit(drive([['captcha.length', 8]]));

    expect(sent.captcha).toEqual({ length: 8, attempts: 3, expiry: 300 });
    expect(sent.embed).toEqual(STORED.embed);
  });
});

describe('live is the stored config plus the unsaved edits', () => {
  test('an untouched form reads back exactly what is stored', () => {
    expect(drive().live).toEqual(STORED);
  });

  test('an edited path reads the edit while every other path reads the store', () => {
    const form = drive([['captcha.attempts', 5]]);

    expect(form.live).toEqual({ ...STORED, captcha: { length: 6, attempts: 5, expiry: 300 } });
    expect(form.value('captcha.attempts')).toBe(5);
    expect(form.value('captcha.length')).toBe(6);
    expect(form.value('domains')).toEqual(['a.example', 'b.example']);
  });

  test('live is what a save submits', () => {
    const form = drive([['mode', 'button']]);

    expect(submit(form)).toEqual(form.live);
  });

  test('an unset path falls through to the fallback the control was given', () => {
    const form = drive();

    expect(form.value('nothing.here')).toBeUndefined();
    expect(form.value('nothing.here', 'default')).toBe('default');
    expect(form.value('message', 'default')).toBe(STORED.message);
  });
});

/**
 * `dirty` is what the leave-confirmation blocker and the save button both read, so an edit typed
 * back to what was already stored has to settle it again. The edit is still tracked — the hook has
 * no way to un-track a path — so this can only work by comparing values, never by counting edits.
 */
describe('dirty follows the values, not the fact that something was typed', () => {
  test('an untouched form is clean', () => {
    expect(drive().dirty).toBe(false);
  });

  test('a changed value is dirty', () => {
    expect(drive([['message', 'Something else']]).dirty).toBe(true);
    expect(drive([['captcha.attempts', 5]]).dirty).toBe(true);
  });

  test('typed away and typed back is clean again', () => {
    const form = drive([
      ['message', 'Something else'],
      ['message', STORED.message],
    ]);

    expect(form.dirty).toBe(false);
    expect(form.value('message')).toBe(STORED.message);
  });

  test('and so is a nested path put back', () => {
    expect(
      drive([
        ['captcha.attempts', 5],
        ['captcha.attempts', 3],
      ]).dirty,
    ).toBe(false);
  });

  test('an object rebuilt with the same contents is not a change', () => {
    expect(drive([['captcha', { length: 6, attempts: 3, expiry: 300 }]]).dirty).toBe(false);
    expect(drive([['domains', ['a.example', 'b.example']]]).dirty).toBe(false);
  });

  test('one path put back does not clean a second that is still changed', () => {
    const form = drive([
      ['message', 'Something else'],
      ['message', STORED.message],
      ['mode', 'button'],
    ]);

    expect(form.dirty).toBe(true);
  });

  test('a clean form still submits the whole stored config, not an empty one', () => {
    const form = drive([['message', STORED.message]]);

    expect(form.dirty).toBe(false);
    expect(submit(form)).toEqual(STORED);
  });
});

describe('what a save leaves in the cache', () => {
  test('the stored config is re-seeded from the server answer, under the key the page reads', async () => {
    const before = cacheWrites.length;
    submit(drive([['message', 'Hello, {user}']]));
    await settle();

    const write = cacheWrites[before];
    expect(write?.key).toEqual([...queryKeys.moduleConfig(GUILD, MODULE)]);
    expect((write?.data as ModuleConfigView | undefined)?.config).toEqual({
      ...STORED,
      message: 'Hello, {user}',
    });
  });

  test('and the module list is invalidated, because a save can change whether it runs', async () => {
    const before = invalidations.length;
    submit(drive([['mode', 'button']]));
    await settle();

    expect(invalidations[before]).toEqual({ queryKey: queryKeys.modules(GUILD) });
  });
});
