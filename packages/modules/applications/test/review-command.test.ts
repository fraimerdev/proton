import { describe, expect, test } from 'bun:test';
import { ButtonStyle, InteractionContextType } from 'discord-api-types/v10';
import type { ApplicationsDeps } from '../src/deps.ts';
import { customId, STAFF_ACTION } from '../src/interface.ts';
import {
  APP_ID,
  APPLICANT,
  APPLICATION,
  type Call,
  configWith,
  customIds,
  DASHBOARD,
  DECIDER_ROLE,
  formConfig,
  GUILD,
  Harness,
  NOW,
  OTHER_GUILD,
  OUTSIDER,
  REVIEWER,
  review,
  said,
  textOf,
  VIEWER_ROLE,
  walk,
} from './staff-harness.ts';

const DEFERRED = 5;

function deps(h: Harness, overrides: Partial<ApplicationsDeps> = {}): ApplicationsDeps {
  return {
    store: h.store,
    applicationId: APPLICATION,
    dashboardUrl: DASHBOARD,
    now: () => NOW,
    ...overrides,
  };
}

async function run(
  h: Harness,
  options: Parameters<Harness['command']>[0],
  bindings: ApplicationsDeps = deps(h),
): Promise<Call[]> {
  const mark = h.calls.length;
  await review.applicationsCommand(bindings).handler(h.command(options));
  return h.since(mark);
}

function answer(calls: readonly Call[]): Call | undefined {
  return calls.filter((call) => call.status === 'executed').at(-1);
}

function links(components: readonly unknown[]): { label: unknown; url: unknown }[] {
  const found: { label: unknown; url: unknown }[] = [];
  walk(components, (component) => {
    if (component.style === ButtonStyle.Link) {
      found.push({ label: component.label, url: component.url });
    }
  });
  return found;
}

function seedMany(h: Harness, count: number, formId = 'mods'): void {
  const template = h.seed();
  for (let index = 0; index < count; index += 1) {
    h.store.seedApplication({
      ...template,
      id: `${formId}-app-${String(index).padStart(3, '0')}`,
      number: 100 + index,
      formId,
      submittedAt: NOW - (count - index) * 60_000,
    });
  }
  h.store.applicationsById.delete(APP_ID);
}

describe('/applications', () => {
  test('is a guild-only command with queue and view, and no default member permissions', () => {
    const command = review.applicationsCommand({});
    const data = command.data as unknown as Record<string, unknown>;

    expect(command.name).toBe('applications');
    expect(data.contexts).toEqual([InteractionContextType.Guild]);
    expect(data.default_member_permissions ?? null).toBe(null);
    expect((data.options as { name: string }[]).map((option) => option.name)).toEqual([
      'queue',
      'view',
    ]);
  });

  test('refuses without deferring when the module is not wired', async () => {
    const h = new Harness();
    const calls = await run(h, { subcommand: 'queue' }, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload.callbackType).toBe(4);
    expect(said(calls[0])).toContain('fault on my side');
    expect(h.logs.some((log) => log.level === 'error')).toBe(true);
  });

  test('refuses when Applications is off in its own settings', async () => {
    const h = new Harness(configWith({ enabled: false }));
    const calls = await run(h, { subcommand: 'queue' });

    expect(calls).toHaveLength(1);
    expect(said(calls[0])).toContain('Applications is off in this server.');
  });

  test('queue defers, then shows counts, the oldest wait and up to five to open', async () => {
    const h = new Harness();
    seedMany(h, 7);

    const calls = await run(h, { subcommand: 'queue' });

    expect(calls[0]?.payload.callbackType).toBe(DEFERRED);
    const shown = answer(calls);
    expect(shown?.kind).toBe('interaction_edit_original');
    expect(shown?.payload.flags).toBe(32768);

    const components = shown?.payload.components as unknown[];
    const text = textOf(components);
    expect(text).toContain('**7** waiting for review');
    expect(text).toContain(
      `The oldest has waited since <t:${Math.floor((NOW - 7 * 60_000) / 1000)}:R>.`,
    );
    expect(text).toContain('The 5 that have waited longest.');
    expect(text).toContain('**#100**');
    expect(text).not.toContain('**#105**');

    const views = customIds(components).filter((id) => id.includes(':card:'));
    expect(views).toHaveLength(5);
    expect(views[0]).toBe(customId(STAFF_ACTION.card, 'mods-app-000'));
    expect(links(components)).toEqual([
      { label: 'Open the review queue', url: `${DASHBOARD}/review/${GUILD}` },
    ]);
    expect(h.invalid).toEqual([]);
  });

  test('queue counts only the forms the member may view', async () => {
    const h = new Harness(
      configWith({
        forms: [
          formConfig(),
          formConfig({
            id: 'partners',
            name: 'Partnership Request',
            review: { useDefaultTeam: false, reviewerRoleIds: [DECIDER_ROLE] },
          }),
        ],
      }),
    );
    seedMany(h, 2, 'mods');
    seedMany(h, 3, 'partners');

    const calls = await run(h, { subcommand: 'queue' });
    const text = textOf(answer(calls)?.payload.components as unknown[]);

    expect(text).toContain('**2** waiting for review');
    expect(text).not.toContain('Partnership Request');
  });

  test('someone on no review team is told so', async () => {
    const h = new Harness();
    h.seed();

    const calls = await run(h, { subcommand: 'queue', userId: OUTSIDER });

    expect(said(answer(calls))).toContain(
      'You aren’t on the review team for any application form in this server.',
    );
  });

  test('an empty queue says nothing is waiting', async () => {
    const h = new Harness();

    const calls = await run(h, { subcommand: 'queue' });

    expect(textOf(answer(calls)?.payload.components as unknown[])).toContain(
      'Nothing is waiting for review.',
    );
  });

  test('view opens the card privately with actions for a reviewer', async () => {
    const h = new Harness();
    h.seed();

    const calls = await run(h, { subcommand: 'view', number: 12 });
    const components = answer(calls)?.payload.components as unknown[];

    expect(calls[0]?.payload.callbackType).toBe(DEFERRED);
    expect(calls[0]?.payload.ephemeral).toBe(true);
    expect(textOf(components)).toContain('## Moderator Application #12');
    expect(customIds(components)).toContain(customId(STAFF_ACTION.accept, APP_ID));
  });

  test('view shows a viewer the card without decision buttons', async () => {
    const h = new Harness();
    h.seed();

    const calls = await run(h, {
      subcommand: 'view',
      number: 12,
      userId: OUTSIDER,
      roleIds: [VIEWER_ROLE],
    });
    const ids = customIds(answer(calls)?.payload.components as unknown[]);

    expect(ids).toEqual([customId(STAFF_ACTION.read, APP_ID)]);
  });

  test('view refuses an outsider, an unknown number, another server and a deleted one', async () => {
    const h = new Harness();
    const seeded = h.seed();

    const outsider = await run(h, { subcommand: 'view', number: 12, userId: OUTSIDER });
    expect(said(answer(outsider))).toContain(
      'You aren’t on the review team for any application form in this server.',
    );
    expect(said(answer(outsider))).not.toContain('Moderator Application');

    const unknown = await run(h, { subcommand: 'view', number: 99 });
    expect(said(answer(unknown))).toContain('There’s no application #99 you can open.');

    h.store.seedApplication({ ...seeded, guildId: OTHER_GUILD });
    const elsewhere = await run(h, { subcommand: 'view', number: 12 });
    expect(said(answer(elsewhere))).toContain('There’s no application #12 you can open.');

    h.seed({ deletedAt: NOW });
    const deleted = await run(h, { subcommand: 'view', number: 12 });
    expect(said(answer(deleted))).toContain('Application #12 was deleted');
  });

  test('view answers the same for a missing, a deleted and an unviewable application', async () => {
    const h = new Harness(
      configWith({
        forms: [
          formConfig(),
          formConfig({
            id: 'partners',
            name: 'Partnership Request',
            review: { useDefaultTeam: false, reviewerRoleIds: [DECIDER_ROLE] },
          }),
        ],
      }),
    );
    const seeded = h.seed();
    h.store.seedApplication({ ...seeded, id: 'partners-app', number: 13, formId: 'partners' });
    h.store.seedApplication({
      ...seeded,
      id: 'partners-gone',
      number: 14,
      formId: 'partners',
      deletedAt: NOW,
    });
    const viewer = { subcommand: 'view' as const, userId: OUTSIDER, roleIds: [VIEWER_ROLE] };

    const texts = [];
    for (const number of [13, 14, 15]) {
      texts.push(said(answer(await run(h, { ...viewer, number }))));
    }

    expect(texts).toEqual([
      expect.stringContaining('There’s no application #13 you can open.'),
      expect.stringContaining('There’s no application #14 you can open.'),
      expect.stringContaining('There’s no application #15 you can open.'),
    ]);
    for (const text of texts) {
      expect(text).not.toContain('Partnership Request');
      expect(text).not.toContain('deleted');
    }
  });

  test('a reviewer who applied can’t open their own application or see its votes', async () => {
    const h = new Harness();
    h.seed();
    await h.store.transition({
      guildId: GUILD,
      applicationId: APP_ID,
      action: 'vote',
      actor: { id: REVIEWER, source: 'discord' },
      expect: { statuses: ['submitted'] },
      patch: {},
      vote: { vote: 'accept', score: null },
      event: { kind: 'voted' },
      bumpRevision: false,
      now: NOW,
    });

    const viewed = await run(h, { subcommand: 'view', number: 12, userId: APPLICANT });
    expect(said(answer(viewed))).toContain('There’s no application #12 you can open.');

    for (const id of [customId(STAFF_ACTION.card, APP_ID), customId(STAFF_ACTION.read, APP_ID)]) {
      const pressed = h.press(id, { userId: APPLICANT, messageFlags: 0 });
      const mark = h.calls.length;
      await h.run(pressed);
      const shown = h.since(mark).map(said).join('\n');
      expect(shown).toContain('There’s no application #12 you can open.');
      expect(shown).not.toContain('accept');
      expect(shown).not.toContain('I like keeping');
    }
  });

  test('view refuses a number past the database’s range without looking it up', async () => {
    const h = new Harness();
    h.seed();
    const byNumber = h.store.byNumber.bind(h.store);
    const asked: number[] = [];
    h.store.byNumber = async (guildId, number) => {
      asked.push(number);
      return byNumber(guildId, number);
    };

    const calls = await run(h, { subcommand: 'view', number: 99_999_999_999 });

    expect(said(answer(calls))).toContain('There’s no application #99999999999 you can open.');
    expect(asked).toEqual([]);

    const data = review.applicationsCommand({}).data as unknown as {
      options: { name: string; options?: { name: string; max_value?: number }[] }[];
    };
    const number = data.options
      .find((option) => option.name === 'view')
      ?.options?.find((option) => option.name === 'number');
    expect(number?.max_value).toBe(2_147_483_647);
  });

  test('a member with no roles read never gets more than an outsider', async () => {
    const h = new Harness();
    h.seed();
    const ctx = h.command({ subcommand: 'view', number: 12, userId: REVIEWER });
    const { actorRoleIds: _roles, actorPermissions: _permissions, ...bare } = ctx;

    const mark = h.calls.length;
    await review.applicationsCommand(deps(h)).handler(bare);

    expect(said(answer(h.since(mark)))).toContain('You aren’t on the review team');
  });
});
