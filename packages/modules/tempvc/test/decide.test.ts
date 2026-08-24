import { describe, expect, test } from 'bun:test';
import {
  CHANNEL_NAME_MAX,
  hubFor,
  renderChannelName,
  type TempVcConfig,
  tempVcConfigSchema,
  tempVcHubSchema,
} from '../src/config.ts';
import {
  planReconcile,
  planTransition,
  type ReconcileRow,
  type TempVcStep,
  type TransitionFacts,
} from '../src/decide.ts';

const HUB = '500000000000000001';
const OTHER_HUB = '500000000000000003';
const TEMP = '500000000000000002';
const ELSEWHERE = '500000000000000005';

const ADA = '700000000000000001';
const BEN = '700000000000000002';
const CAT = '700000000000000003';

function configWith(overrides: Record<string, unknown> = {}): TempVcConfig {
  return {
    ...tempVcConfigSchema.parse({}),
    enabled: true,
    hubs: [
      tempVcHubSchema.parse({ channelId: HUB, nameTemplate: '{user}’s room', ...overrides }),
      tempVcHubSchema.parse({ channelId: OTHER_HUB, nameTemplate: '{user} II', userLimit: 4 }),
    ],
  };
}

const config = configWith();

function facts(overrides: Partial<TransitionFacts> = {}): TransitionFacts {
  return {
    transition: { userId: ADA, from: null, to: null },
    fromTemp: null,
    fromOccupantsAfter: 0,
    fromOccupants: [],
    toTemp: null,
    ownedChannelId: null,
    ...overrides,
  };
}

const kinds = (steps: readonly TempVcStep[]): string[] => steps.map((step) => step.kind);

describe('joining a creator channel', () => {
  test('makes a channel', () => {
    const plan = planTransition(
      config,
      facts({ transition: { userId: ADA, from: null, to: HUB } }),
    );

    expect(kinds(plan.steps)).toEqual(['create']);
  });

  test('sends a member who already has one to it instead of making a second', () => {
    const plan = planTransition(
      config,
      facts({ transition: { userId: ADA, from: null, to: HUB }, ownedChannelId: TEMP }),
    );

    expect(plan.steps).toEqual([{ kind: 'move', channelId: TEMP }]);
  });

  test('a disabled creator channel is not a creator channel', () => {
    const off = configWith({ enabled: false });

    expect(hubFor(off, HUB)).toBeUndefined();
    expect(
      planTransition(off, facts({ transition: { userId: ADA, from: null, to: HUB } })).steps,
    ).toEqual([]);
  });

  test('joining anything else does nothing', () => {
    expect(
      planTransition(config, facts({ transition: { userId: ADA, from: null, to: ELSEWHERE } }))
        .steps,
    ).toEqual([]);
  });

  test('a member who did not move is left alone', () => {
    expect(
      planTransition(config, facts({ transition: { userId: ADA, from: HUB, to: HUB } })).steps,
    ).toEqual([]);
  });
});

describe('leaving a temporary channel', () => {
  const temp = { id: 'row-1', ownerId: ADA, hubChannelId: HUB };

  test('the last one out schedules the delete rather than doing it', () => {
    const plan = planTransition(
      config,
      facts({ transition: { userId: ADA, from: TEMP, to: null }, fromTemp: temp }),
    );

    expect(kinds(plan.steps)).toEqual(['revoke-roles', 'schedule-delete']);
  });

  test('a channel other people are still in is not scheduled at all', () => {
    const plan = planTransition(
      config,
      facts({
        transition: { userId: BEN, from: TEMP, to: null },
        fromTemp: temp,
        fromOccupantsAfter: 1,
        fromOccupants: [ADA],
      }),
    );

    expect(kinds(plan.steps)).toEqual(['revoke-roles']);
  });

  /** This is the case the deferred delete exists for: Discord fires leave-then-join on a switch. */
  test('walking back in cancels the pending delete', () => {
    const plan = planTransition(
      config,
      facts({ transition: { userId: ADA, from: ELSEWHERE, to: TEMP }, toTemp: temp }),
    );

    expect(kinds(plan.steps)).toEqual(['cancel-delete', 'grant-role']);
  });
});

describe('when the owner walks out', () => {
  const temp = { id: 'row-1', ownerId: ADA, hubChannelId: HUB };

  function ownerLeaves(mode: string) {
    return planTransition(
      configWith({ ownerlessMode: mode }),
      facts({
        transition: { userId: ADA, from: TEMP, to: null },
        fromTemp: temp,
        fromOccupantsAfter: 2,
        fromOccupants: [BEN, CAT],
      }),
    );
  }

  test('claim leaves it open for whoever is inside', () => {
    const step = ownerLeaves('claim').steps.find((s) => s.kind === 'ownerless');

    expect(step).toMatchObject({ mode: 'claim', heir: null });
  });

  test('transfer names the member who has been there longest', () => {
    const step = ownerLeaves('transfer').steps.find((s) => s.kind === 'ownerless');

    expect(step).toMatchObject({ mode: 'transfer', heir: BEN });
  });

  test('keep asks for nothing to change', () => {
    const step = ownerLeaves('keep').steps.find((s) => s.kind === 'ownerless');

    expect(step).toMatchObject({ mode: 'keep' });
  });

  test('a non-owner leaving never triggers it', () => {
    const plan = planTransition(
      config,
      facts({
        transition: { userId: BEN, from: TEMP, to: null },
        fromTemp: temp,
        fromOccupantsAfter: 1,
        fromOccupants: [ADA],
      }),
    );

    expect(kinds(plan.steps)).not.toContain('ownerless');
  });
});

describe('reconciling after a restart', () => {
  const NOW = new Date('2026-08-23T12:00:00Z');
  const STALE = new Date(NOW.getTime() - 60_000);

  function rows(...entries: ReconcileRow[]) {
    return entries;
  }

  test('an occupied channel is kept and its stale deadline cleared', () => {
    const plan = planReconcile({
      known: rows({ id: 'a', channelId: TEMP, status: 'live' }),
      occupantsByChannel: new Map([[TEMP, [ADA]]]),
      liveChannelIds: new Set([TEMP]),
      staleBefore: STALE,
      rowCreatedAt: () => NOW,
    });

    expect(plan.keep).toEqual(['a']);
    expect(plan.delete).toEqual([]);
  });

  test('an empty channel is deleted', () => {
    const plan = planReconcile({
      known: rows({ id: 'a', channelId: TEMP, status: 'live' }),
      occupantsByChannel: new Map(),
      liveChannelIds: new Set([TEMP]),
      staleBefore: STALE,
      rowCreatedAt: () => NOW,
    });

    expect(plan.delete).toEqual(['a']);
  });

  test('a channel Discord no longer lists is forgotten, not deleted again', () => {
    const plan = planReconcile({
      known: rows({ id: 'a', channelId: TEMP, status: 'live' }),
      occupantsByChannel: new Map(),
      liveChannelIds: new Set(),
      staleBefore: STALE,
      rowCreatedAt: () => NOW,
    });

    expect(plan.forget).toEqual(['a']);
    expect(plan.delete).toEqual([]);
  });

  /** A reservation whose create died half-way. Forgetting it frees the owner's slot. */
  test('an old reservation that never became a channel is forgotten', () => {
    const plan = planReconcile({
      known: rows({ id: 'a', channelId: null, status: 'reserving' }),
      occupantsByChannel: new Map(),
      liveChannelIds: new Set(),
      staleBefore: STALE,
      rowCreatedAt: () => new Date(NOW.getTime() - 120_000),
    });

    expect(plan.forget).toEqual(['a']);
  });

  test('a reservation made a moment ago is left alone, because it is still in flight', () => {
    const plan = planReconcile({
      known: rows({ id: 'a', channelId: null, status: 'reserving' }),
      occupantsByChannel: new Map(),
      liveChannelIds: new Set(),
      staleBefore: STALE,
      rowCreatedAt: () => NOW,
    });

    expect(plan.forget).toEqual([]);
    expect(plan.delete).toEqual([]);
  });

  test('with no channel list nothing is assumed gone', () => {
    const plan = planReconcile({
      known: rows({ id: 'a', channelId: TEMP, status: 'live' }),
      occupantsByChannel: new Map([[TEMP, [ADA]]]),
      liveChannelIds: null,
      staleBefore: STALE,
      rowCreatedAt: () => NOW,
    });

    expect(plan.forget).toEqual([]);
    expect(plan.keep).toEqual(['a']);
  });
});

function named(displayName: string) {
  return { displayName, username: 'ada', userId: ADA };
}

describe('renderChannelName', () => {
  test('fills the owner placeholder', () => {
    expect(renderChannelName('{user}’s room', named('Ada'))).toBe('Ada’s room');
  });

  test('fills every placeholder the spec names', () => {
    expect(renderChannelName('{displayName} {username} {userId}', named('Ada'))).toBe(
      `Ada ada ${ADA}`,
    );
  });

  test('fills a repeated placeholder every time', () => {
    expect(renderChannelName('{user} and {user}', named('Ada'))).toBe('Ada and Ada');
  });

  test('clamps to what Discord accepts', () => {
    expect(renderChannelName('{user}', named('x'.repeat(500)))).toHaveLength(CHANNEL_NAME_MAX);
  });

  test('a template that renders to nothing falls back to the name', () => {
    expect(renderChannelName('{username}', { displayName: 'Ada', username: '', userId: ADA })).toBe(
      'Ada',
    );
  });
});

describe('the config schema', () => {
  test('refuses a name template with no placeholder, because every channel would share a name', () => {
    expect(
      tempVcConfigSchema.safeParse({ hubs: [{ channelId: HUB, nameTemplate: 'Voice' }] }).success,
    ).toBe(false);
  });

  test('refuses two creator channels on the same channel', () => {
    expect(
      tempVcConfigSchema.safeParse({ hubs: [{ channelId: HUB }, { channelId: HUB }] }).success,
    ).toBe(false);
  });

  test('refuses a temporary role mode with no role to hand out', () => {
    expect(
      tempVcConfigSchema.safeParse({
        hubs: [{ channelId: HUB, temporaryRoleMode: 'owner' }],
      }).success,
    ).toBe(false);
  });

  test('refuses a delete delay longer than the bound', () => {
    expect(
      tempVcConfigSchema.safeParse({ hubs: [{ channelId: HUB, emptyDeleteDelay: '2h' }] }).success,
    ).toBe(false);
  });

  /** A stored v1 creator channel is five keys. It must survive the reshape untouched. */
  test('a v1 creator channel parses into the new shape on its defaults', () => {
    const parsed = tempVcConfigSchema.parse({
      enabled: true,
      ownerCommands: true,
      hubs: [{ channelId: HUB, categoryId: ELSEWHERE, nameTemplate: '{user}', userLimit: 3 }],
    });

    expect(parsed.hubs[0]).toMatchObject({
      channelId: HUB,
      userLimit: 3,
      enabled: true,
      privacy: 'public',
      ownerlessMode: 'claim',
      maxChannelsPerUser: 1,
      emptyDeleteDelay: '5s',
    });

    expect(parsed.hubs[0]?.allow.rename).toBe(true);
  });

  test('defaults leave the module off with no creator channels', () => {
    expect(tempVcConfigSchema.parse({})).toMatchObject({ enabled: false, hubs: [] });
  });
});
