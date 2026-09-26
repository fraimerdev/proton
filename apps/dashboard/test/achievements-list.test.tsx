import { afterEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModuleConfigView } from '@proton/core';
import {
  type Achievement,
  type AchievementsConfig,
  achievementsConfigSchema,
} from '@proton/module-achievements/config';
import type { AchievementsOverview, OverviewAchievement } from '@proton/module-achievements/view';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { renderToString } from 'react-dom/server';

const SRC = join(import.meta.dir, '..', 'src');

const GUILD = '900000000000000002';
const NOW = Date.parse('2026-09-19T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

for (const file of readdirSync(join(SRC, 'server'))) {
  const source = readFileSync(join(SRC, 'server', file), 'utf8');
  const names = [...source.matchAll(/^export (?:const|(?:async )?function) (\w+)/gm)].map(
    ([, name]) => name as string,
  );

  mock.module(`../src/server/${file}`, () =>
    Object.fromEntries(names.map((name) => [name, async () => null])),
  );
}

const QUERIES = readFileSync(join(SRC, 'lib', 'queries.ts'), 'utf8');

mock.module('../src/lib/queries.ts', () => ({
  ...Object.fromEntries(
    [...QUERIES.matchAll(/^export (?:function|const) (\w+)/gm)].map(([, name]) => [
      name,
      (...args: unknown[]) => ({ queryKey: ['stub', name, ...args], enabled: false }),
    ]),
  ),
  MEMBER_LOOKUP_MAX: 100,
  modulesQuery: (guildId: string) => ({
    queryKey: ['achievements-list', 'modules', guildId],
    queryFn: async () => ({ modules: [] }),
  }),
  rolesQuery: (guildId: string) => ({
    queryKey: ['achievements-list', 'roles', guildId],
    queryFn: async () => [],
  }),
  channelsQuery: (guildId: string) => ({
    queryKey: ['achievements-list', 'channels', guildId],
    queryFn: async () => [],
  }),
}));

const route = await import('../src/components/module/route.tsx');
let search: Record<string, unknown> = {};

mock.module('../src/components/module/route.tsx', () => ({
  ...route,
  ModuleLink: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
  useModuleSearch: () => search,
  useModuleNavigate: () => () => undefined,
}));

const {
  ListArea,
  earnedLabel,
  failedLabel,
  matchesFilter,
  matchesSearch,
  needsAttention,
  statusFilterOf,
} = await import('../src/pages/achievements/list.tsx');
const { MODULE_BY_ID } = await import('../src/lib/modules/catalogue.ts');
const { queryKeys } = await import('../src/lib/query-keys.ts');
const { ScheduleEditor } = await import('../src/pages/achievements/schedule.tsx');
const { ProgressPanel } = await import('../src/pages/achievements/progress-panel.tsx');
const { BadgeEditor } = await import('../src/pages/achievements/badge-editor.tsx');
const { EditNotices, structureSaveNote, useStructureLocks } = await import(
  '../src/pages/achievements/edit-notices.tsx'
);
const { deleteBody } = await import('../src/pages/achievements/editor.tsx');

const META = MODULE_BY_ID.get('achievements');
if (META === undefined) throw new Error('the catalogue has no achievements entry');

afterEach(() => {
  setSystemTime();
  search = {};
});

function achievement(
  overrides: Partial<Achievement> & Pick<Achievement, 'id' | 'name'>,
): Achievement {
  return {
    description: '',
    status: 'active',
    badge: { shape: 'circle', icon: 'trophy', colour: 'tier' },
    kind: 'single',
    requirements: [
      { id: 'msg', version: 1, trigger: 'messages.sent', channelIds: [], excludedChannelIds: [] },
    ],
    tiers: [{ id: 'single', targets: { msg: 100 }, rewards: [] }],
    roleIds: [],
    excludedRoleIds: [],
    includeRecorded: false,
    almostThere: { enabled: false, percent: 80 },
    announcement: { mode: 'default' },
    ...overrides,
  };
}

const CHATTERBOX = achievement({
  id: 'chatterbox',
  name: 'Chatterbox',
  description: 'Keep the conversation going.',
  kind: 'tiered',
  tiers: [
    { id: 'bronze', targets: { msg: 50 }, rewards: [] },
    { id: 'silver', targets: { msg: 250 }, rewards: [] },
    { id: 'gold', targets: { msg: 1000 }, rewards: [] },
  ],
});

const NIGHT_OWL = achievement({ id: 'night-owl', name: 'Night Owl', status: 'draft' });

const REGULAR = achievement({ id: 'regular', name: 'Regular', status: 'paused' });

const SUMMER = achievement({
  id: 'summer-event',
  name: 'Summer Event',
  endsAt: new Date(NOW - DAY).toISOString(),
});

const WINTER = achievement({
  id: 'winter-event',
  name: 'Winter Event',
  startsAt: new Date(NOW + 30 * DAY).toISOString(),
});

const RETIRED = achievement({ id: 'retired', name: 'Old Badge', status: 'archived' });

const RISING = achievement({
  id: 'rising-star',
  name: 'Rising Star',
  requirements: [
    { id: 'lvl', version: 1, trigger: 'leveling.level', channelIds: [], excludedChannelIds: [] },
  ],
  tiers: [{ id: 'single', targets: { lvl: 5 }, rewards: [] }],
});

const ALL = [CHATTERBOX, NIGHT_OWL, REGULAR, SUMMER, WINTER, RETIRED, RISING];

function entry(id: string, overrides: Partial<OverviewAchievement> = {}): OverviewAchievement {
  return {
    id,
    firstActiveAt: NOW - 90 * DAY,
    startsAt: null,
    holders: { single: 0, bronze: 0, silver: 0, gold: 0, diamond: 0 },
    inProgress: 0,
    rewards: { pending: 0, failed: 0 },
    job: null,
    ...overrides,
  };
}

const OVERVIEW: AchievementsOverview = {
  recordingSince: NOW - 120 * DAY,
  periods: { module: [{ start: NOW - 120 * DAY, end: null }] },
  achievements: [
    entry('chatterbox', {
      holders: { single: 0, bronze: 42, silver: 12, gold: 3, diamond: 0 },
      rewards: { pending: 0, failed: 2 },
    }),
    entry('regular', { holders: { single: 1, bronze: 0, silver: 0, gold: 0, diamond: 0 } }),
    entry('summer-event'),
  ],
};

function formFor(achievements: readonly Achievement[], tier: 'free' | 'plus' | 'pro' = 'pro') {
  const config: AchievementsConfig = achievementsConfigSchema.parse({
    enabled: true,
    achievements,
  });

  const view = {
    moduleId: 'achievements',
    enabled: true,
    config,
    schemaVersion: 1,
    migrated: false,
    tier,
    postables: [],
    simulations: [],
  } as unknown as ModuleConfigView;

  const noop = (): void => undefined;

  return {
    view,
    value: config,
    setValue: noop,
    rebase: noop,
    get: () => undefined,
    set: noop,
    dirty: false,
    errors: new Map<string, string>(),
    errorAt: () => undefined,
    templateDiagnosticsAt: () => [],
    save: noop,
    reset: noop,
    saving: false,
    saveError: null,
    failures: 0,
    changedElsewhere: false,
  };
}

function renderWith(
  node: ReactElement,
  enabled: readonly string[] = ['achievements'],
  overview: AchievementsOverview | null = OVERVIEW,
): string {
  setSystemTime(new Date(NOW));

  const client = new QueryClient();
  client.setQueryData(['achievements-list', 'modules', GUILD], {
    modules: enabled.map((id) => ({ id, enabled: true })),
  });
  if (overview !== null) client.setQueryData(queryKeys.achievementsOverview(GUILD), overview);

  return renderToString(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  ).replaceAll('<!-- -->', '');
}

function render(
  achievements: readonly Achievement[],
  link: Record<string, unknown> = {},
  options: { tier?: 'free' | 'plus' | 'pro'; enabled?: readonly string[] } = {},
): string {
  search = { area: 'list', ...link };

  return renderWith(
    <ListArea
      guildId={GUILD}
      form={formFor(achievements, options.tier)}
      meta={META as NonNullable<typeof META>}
      summary={undefined}
    />,
    options.enabled,
  );
}

function rowTitles(html: string): string[] {
  return [...html.matchAll(/collection-row-title"><span class="truncate">([^<]+)</g)].map(
    ([, title]) => title as string,
  );
}

describe('the achievements list', () => {
  test('shows each achievement with the status it has right now', () => {
    const html = render(ALL);

    for (const name of ['Chatterbox', 'Night Owl', 'Regular', 'Summer Event', 'Winter Event']) {
      expect(html).toContain(name);
    }

    expect(html).toContain('badge-success">Active<');
    expect(html).toContain('>Draft<');
    expect(html).toContain('>Paused<');
    expect(html).toContain('Paused by an admin');
    expect(html).toContain('>Expired<');
    expect(html).toContain('The deadline has passed');
    expect(html).toContain('badge-info">Scheduled<');
    expect(html).toContain('Waiting for its start date');
    expect(html).toContain('>Archived<');
  });

  test('an achievement whose module is off says which module, and counts as needing attention', () => {
    const html = render([RISING]);

    expect(html).toContain('badge-warning">Paused<');
    expect(html).toContain('Leveling is off in this server');

    const on = render([RISING], {}, { enabled: ['achievements', 'leveling'] });
    expect(on).toContain('badge-success">Active<');
    expect(on).not.toContain('Leveling is off');
  });

  test('rows say what counts, the tiers, how many earned it and how many rewards failed', () => {
    const html = render(ALL);

    expect(html).toContain('Send messages');
    expect(html).toContain('Bronze 50');
    expect(html).toContain('Silver 250');
    expect(html).toContain('Gold 1,000');
    expect(html).toContain('Single');
    expect(html).toContain('42 members earned');
    expect(html).toContain('1 member earned');
    expect(html).toContain('Not earned yet');
    expect(html).toContain('2 rewards failed');
  });

  test('the status filter comes from the link, and an unknown one shows everything', () => {
    expect(rowTitles(render(ALL, { status: 'draft' }))).toEqual(['Night Owl']);
    expect(rowTitles(render(ALL, { status: 'archived' }))).toEqual(['Old Badge']);
    expect(rowTitles(render(ALL, { status: 'expired' }))).toEqual(['Summer Event']);
    expect(rowTitles(render(ALL, { status: 'scheduled' }))).toEqual(['Winter Event']);
    expect(rowTitles(render(ALL, { status: 'attention' }))).toEqual(['Chatterbox', 'Rising Star']);
    expect(rowTitles(render(ALL, { status: 'nonsense' }))).toHaveLength(ALL.length);
  });

  test('the search term comes from the link and looks at names, descriptions and what counts', () => {
    expect(rowTitles(render(ALL, { q: 'owl' }))).toEqual(['Night Owl']);
    expect(rowTitles(render(ALL, { q: 'conversation' }))).toEqual(['Chatterbox']);
    expect(rowTitles(render(ALL, { q: 'reach a level' }))).toEqual(['Rising Star']);
  });

  test('says so when there are none, when nothing matches and when a link points nowhere', () => {
    const none = render([]);
    expect(none).toContain('No achievements yet');
    expect(none).toContain('Create one from scratch or start from a preset.');

    const unmatched = render(ALL, { q: 'zzz' });
    expect(unmatched).toContain('No matching achievements');
    expect(unmatched).toContain(
      'Search looks at names, descriptions and what each achievement counts.',
    );

    const filtered = render([NIGHT_OWL], { status: 'archived' });
    expect(filtered).toContain('No matching achievements');
    expect(filtered).toContain('No achievement is archived.');

    const missing = render(ALL, { id: 'gone-for-good' });
    expect(missing).toContain('Achievement not found');
    expect(missing).toContain('It may have been deleted.');
    expect(missing).toContain('Back to achievements');
  });

  test('at the tier’s limit the create button is off and says why', () => {
    const ten = Array.from({ length: 10 }, (_, index) =>
      achievement({ id: `achievement-${index}`, name: `Achievement ${index}` }),
    );

    const full = render(ten, {}, { tier: 'free' });
    expect(full).toContain('10 / 10');
    expect(full).toContain('Free allows 10 achievements');
    expect(full).toMatch(/<button[^>]*disabled=""[^>]*title="Free allows 10 achievements"/);

    const room = render(ten, {}, { tier: 'plus' });
    expect(room).toContain('10 / 50');
    expect(room).not.toContain('allows 50 achievements');
  });

  test('a row whose settings the api would refuse is marked and needs attention', () => {
    const dependent = achievement({
      id: 'all-rounder',
      name: 'All-Rounder',
      requirements: [
        {
          id: 'pre',
          version: 1,
          trigger: 'achievements.unlocked',
          channelIds: [],
          excludedChannelIds: [],
          achievementId: 'deleted-one',
        },
      ],
      tiers: [{ id: 'single', targets: { pre: 1 }, rewards: [] }],
    });

    const html = render([CHATTERBOX, dependent]);
    expect(html).toContain('A setting needs fixing before saving');

    expect(rowTitles(render([CHATTERBOX, dependent], { status: 'attention' }))).toEqual([
      'Chatterbox',
      'All-Rounder',
    ]);
    expect(render([CHATTERBOX])).not.toContain('A setting needs fixing before saving');
  });

  test('a link to an achievement opens its editor on the draft’s own status', () => {
    const html = render(ALL, { id: 'night-owl' });

    expect(html).toContain('Make active');
    expect(html).toContain('>Requirements<');
    expect(html).toContain('>Progress<');
    expect(html).not.toContain('No matching achievements');
  });
});

describe('the list’s filter helpers', () => {
  test('statusFilterOf accepts only the filters the select offers', () => {
    expect(statusFilterOf(undefined)).toBe('all');
    expect(statusFilterOf('attention')).toBe('attention');
    expect(statusFilterOf('Active')).toBe('all');
  });

  test('needs attention means failed rewards or a module that is off', () => {
    expect(needsAttention({ status: 'active' }, undefined)).toBe(false);
    expect(
      needsAttention({ status: 'active' }, entry('x', { rewards: { pending: 3, failed: 0 } })),
    ).toBe(false);
    expect(
      needsAttention({ status: 'active' }, entry('x', { rewards: { pending: 0, failed: 1 } })),
    ).toBe(true);
    expect(
      needsAttention({ status: 'paused', reason: 'x', blockedBy: ['starboard'] }, undefined),
    ).toBe(true);
    expect(matchesFilter('paused', { status: 'paused' }, undefined)).toBe(true);
    expect(matchesFilter('active', { status: 'paused' }, undefined)).toBe(false);
  });

  test('search ignores case and surrounding space', () => {
    expect(matchesSearch(CHATTERBOX, '  CHATTER ')).toBe(true);
    expect(matchesSearch(CHATTERBOX, 'voice')).toBe(false);
    expect(matchesSearch(CHATTERBOX, '')).toBe(true);
  });

  test('counts read as sentences', () => {
    expect(earnedLabel(0)).toBe('Not earned yet');
    expect(earnedLabel(1)).toBe('1 member earned');
    expect(earnedLabel(1200)).toBe('1,200 members earned');
    expect(failedLabel(1)).toBe('1 reward failed');
    expect(failedLabel(3)).toBe('3 rewards failed');
  });
});

describe('the editor’s tabs', () => {
  const noop = (): void => undefined;
  const noError = (): undefined => undefined;

  function schedule(subject: Achievement, saved: Achievement | null = subject): string {
    return renderWith(
      <ScheduleEditor
        guildId={GUILD}
        moduleId="achievements"
        achievement={subject}
        saved={saved}
        zone="Europe/London"
        path="achievements.0"
        errorAt={noError}
        update={noop}
      />,
    );
  }

  test('schedule shows times in the module’s zone, at the offset of each instant', () => {
    const html = schedule({ ...WINTER, endsAt: new Date(NOW + 60 * DAY).toISOString() });

    expect(html).toContain('Times are in Europe/London (UTC+01:00)');
    expect(html).toContain('value="2026-10-19"');
    expect(html).toContain('value="13:00"');
    expect(html).toContain('Starts 19 Oct 2026, 13:00 Europe/London (UTC+01:00)');
    expect(html).toContain('Ends 18 Nov 2026, 12:00 Europe/London (UTC+00:00)');
    expect(html).toContain('up to 365 days back. Recording started on 22 May 2026.');
  });

  test('a new deadline in the past is refused before the save, and an old one is not', () => {
    const lapsed = { ...CHATTERBOX, endsAt: new Date(NOW - DAY).toISOString() };

    expect(schedule(lapsed, CHATTERBOX)).toContain('This deadline has already passed.');
    expect(schedule(lapsed, lapsed)).not.toContain('This deadline has already passed.');
  });

  test('a state requirement has no recorded progress to include', () => {
    const html = schedule(RISING);

    expect(html).not.toContain('Include recorded progress');
    expect(html).not.toContain('Members already at or above it');
  });

  test('progress shows the saved achievement’s holders and lets its jobs run', () => {
    const html = renderWith(
      <ProgressPanel
        guildId={GUILD}
        moduleId="achievements"
        form={formFor(ALL)}
        achievement={CHATTERBOX}
      />,
    );

    expect(html).toContain('42 members');
    expect(html).toContain('12 members');
    expect(html).toContain('3 members');
    expect(html).toContain('Retry them in Members');
    expect(html).toContain('Re-check members');
    expect(html).not.toContain('Save your changes first');
  });

  test('progress jobs wait for the save, and an unsaved achievement has no progress', () => {
    const edited = renderWith(
      <ProgressPanel
        guildId={GUILD}
        moduleId="achievements"
        form={formFor(ALL)}
        achievement={{ ...CHATTERBOX, name: 'Chatty' }}
      />,
    );
    expect(edited).toContain('Save your changes first. This uses the saved version.');
    expect(edited).toMatch(/<button[^>]*disabled=""[^>]*>Re-check members<\/button>/);

    const fresh = renderWith(
      <ProgressPanel
        guildId={GUILD}
        moduleId="achievements"
        form={formFor(ALL)}
        achievement={achievement({ id: 'brand-new', name: 'Brand new', status: 'draft' })}
      />,
    );
    expect(fresh).toContain('No progress yet');
  });

  test('the badge tab previews each tier, and an image replaces the icon setting', () => {
    const tiers = renderWith(
      <BadgeEditor
        guildId={GUILD}
        achievement={CHATTERBOX}
        path="achievements.0"
        errorAt={noError}
        update={noop}
      />,
    );
    expect(tiers).toContain('aria-label="Icon: Trophy"');
    expect(tiers).toContain('<figcaption>Bronze</figcaption>');
    expect(tiers).toContain('<figcaption>Gold</figcaption>');

    const image = renderWith(
      <BadgeEditor
        guildId={GUILD}
        achievement={{ ...CHATTERBOX, badge: { ...CHATTERBOX.badge, assetId: 'abcdef0123' } }}
        path="achievements.0"
        errorAt={noError}
        update={noop}
      />,
    );
    expect(image).toContain('Use an icon instead');
    expect(image).not.toContain('aria-label="Icon: ');
  });

  test('edit notices appear only once members hold or work toward it', () => {
    const retargeted = {
      ...CHATTERBOX,
      tiers: CHATTERBOX.tiers.map((tier) => ({ ...tier, targets: { msg: 5_000 } })),
    };

    const held = renderWith(
      <EditNotices
        guildId={GUILD}
        achievement={retargeted}
        saved={CHATTERBOX}
        onDuplicateVersion={noop}
      />,
    );
    expect(held).toContain('Targets changed');
    expect(held).toContain('Earned tiers stay earned.');

    const quiet = renderWith(
      <EditNotices
        guildId={GUILD}
        achievement={{ ...SUMMER, tiers: [{ id: 'single', targets: { msg: 9 }, rewards: [] }] }}
        saved={SUMMER}
        onDuplicateVersion={noop}
      />,
    );
    expect(quiet).toBe('');
  });

  test('dropping a tier members hold needs a new version', () => {
    const html = renderWith(
      <EditNotices
        guildId={GUILD}
        achievement={{ ...CHATTERBOX, tiers: CHATTERBOX.tiers.slice(0, 2) }}
        saved={CHATTERBOX}
        onDuplicateVersion={noop}
      />,
    );

    expect(html).toContain('Needs a new version');
    expect(html).toContain('Duplicate as a new version');
  });

  test('a structural change is locked while Proton has no holders to go on', () => {
    const html = renderWith(
      <EditNotices
        guildId={GUILD}
        achievement={{ ...CHATTERBOX, tiers: CHATTERBOX.tiers.slice(0, 2) }}
        saved={CHATTERBOX}
        onDuplicateVersion={noop}
      />,
      ['achievements'],
      null,
    );

    expect(html).toContain('Checking who holds this');
    expect(html).toContain('Until it knows, switching between single and tiered');
    expect(html).toContain('Try again');
    expect(html).not.toContain('Needs a new version');
  });

  test('the save note locks a structural change until the holders are known', () => {
    const configOf = (achievements: readonly Achievement[]): AchievementsConfig =>
      achievementsConfigSchema.parse({ enabled: true, achievements });

    const saved = configOf([CHATTERBOX]);
    const toSingle = configOf([
      {
        ...CHATTERBOX,
        kind: 'single',
        tiers: [{ id: 'single', targets: { msg: 50 }, rewards: [] }],
      },
    ]);

    function Note({ draft }: { draft: AchievementsConfig }): ReactElement {
      return <span>{structureSaveNote(useStructureLocks(GUILD, draft, saved)) ?? 'nothing'}</span>;
    }

    expect(renderWith(<Note draft={toSingle} />)).toContain('Members already hold Chatterbox');
    expect(renderWith(<Note draft={toSingle} />, ['achievements'], null)).toContain(
      'Proton is checking whether members hold Chatterbox…',
    );
    expect(renderWith(<Note draft={saved} />, ['achievements'], null)).toContain('nothing');
  });

  test('a job left queued by a restart stops blocking new ones after six hours', () => {
    const stranded: AchievementsOverview = {
      ...OVERVIEW,
      achievements: [
        entry('chatterbox', {
          job: {
            kind: 'rebuild',
            status: 'running',
            requestedAt: NOW - 7 * HOUR,
            finishedAt: null,
            result: null,
          },
        }),
      ],
    };

    const html = renderWith(
      <ProgressPanel
        guildId={GUILD}
        moduleId="achievements"
        form={formFor(ALL)}
        achievement={CHATTERBOX}
      />,
      ['achievements'],
      stranded,
    );

    expect(html).toContain('Proton stopped before finishing');
    expect(html).not.toContain('Rebuilding from recorded activity…');
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Re-check members<\/button>/);

    const running: AchievementsOverview = {
      ...OVERVIEW,
      achievements: [
        entry('chatterbox', {
          job: {
            kind: 'rebuild',
            status: 'running',
            requestedAt: NOW - HOUR,
            finishedAt: null,
            result: null,
          },
        }),
      ],
    };

    const busy = renderWith(
      <ProgressPanel
        guildId={GUILD}
        moduleId="achievements"
        form={formFor(ALL)}
        achievement={CHATTERBOX}
      />,
      ['achievements'],
      running,
    );

    expect(busy).toContain('Proton is already working on this achievement.');
    expect(busy).toContain('Rebuilding from recorded activity…');
    expect(busy).toMatch(/<button[^>]*disabled=""[^>]*>Re-check members<\/button>/);
  });

  test('deleting an achievement another one requires says so first', () => {
    expect(deleteBody([])).toBe('Members keep the badges they earned. It’s removed when you save.');
    expect(deleteBody([NIGHT_OWL])).toContain(
      'Night Owl requires it, so nothing can be saved until that requirement is changed.',
    );
    expect(deleteBody([NIGHT_OWL, REGULAR])).toContain(
      'Night Owl and Regular require it, so nothing can be saved until those requirements are changed.',
    );
  });
});
