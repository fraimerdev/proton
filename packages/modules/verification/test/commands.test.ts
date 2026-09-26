import { describe, expect, test } from 'bun:test';
import {
  formatCommandLabel,
  INTERACTION_CALLBACK_CHANNEL_MESSAGE,
  INTERACTION_CALLBACK_DEFERRED_MESSAGE,
  MESSAGE_FLAG_EPHEMERAL,
  type RawOption,
  STATUS_ERROR_COLOUR,
  STATUS_SUCCESS_COLOUR,
} from '@proton/core';
import type { VerificationConfig } from '../src/config.ts';
import { verificationModule } from '../src/index.ts';
import type { QuarantineRecord } from '../src/store.ts';
import {
  ABOVE_BOT_ROLE,
  APPLICATION,
  CAPTCHA,
  COMMAND_INTERACTION,
  EVERYONE_ROLE,
  GATED,
  GUILD,
  type Harness,
  harness,
  INTERACTION_TOKEN,
  LOW_ROLE,
  MEMBER,
  MemoryBlockedMemberStore,
  MID_ROLE,
  MODERATOR,
  QUARANTINE_ROLE,
  QUARANTINED,
  subcommand,
  UNVERIFIED_ROLE,
  userOption,
  VERIFIED_ROLE,
  WEBSITE,
} from './harness.ts';

const CALLBACK_PATH = `/interactions/${COMMAND_INTERACTION}/${INTERACTION_TOKEN}/callback`;

const FOLLOWUP_PATH = `/webhooks/${APPLICATION}/${INTERACTION_TOKEN}`;

const STRANGER = '400000000000000009';

const OTHER_APPLICATION = '800000000000000002';

interface Case {
  name: string;
  command: 'verify' | 'quarantine';
  options: RawOption[];
  config: Partial<VerificationConfig>;
  arrange?: (h: Harness) => void | Promise<void>;
  says: string;
  colour: number;
}

function record(userId: string): QuarantineRecord {
  return {
    guildId: GUILD,
    userId,
    priorRoleIds: [MID_ROLE, LOW_ROLE],
    quarantinedBy: MODERATOR,
    reason: null,
    quarantinedAt: 1_750_000_000_000,
  };
}

async function quarantined(h: Harness): Promise<void> {
  await h.quarantine.put(record(MEMBER));
  h.memberRoles.set(MEMBER, new Set([EVERYONE_ROLE, QUARANTINE_ROLE]));
}

function unverified(h: Harness): void {
  h.memberRoles.set(MODERATOR, new Set([EVERYONE_ROLE, UNVERIFIED_ROLE]));
}

function blockedList(...userIds: string[]): MemoryBlockedMemberStore {
  const list = new MemoryBlockedMemberStore();
  for (const userId of userIds) list.add(GUILD, userId);

  return list;
}

const add = (userId = MEMBER) => subcommand('add', [userOption('user', userId)]);
const remove = (userId = MEMBER) => subcommand('remove', [userOption('user', userId)]);

const cases: Case[] = [
  {
    name: '/verify while verification is off',
    command: 'verify',
    options: [],
    config: { enabled: false },
    says: 'Verification is off in this server. An admin can turn it on in the Proton dashboard.',
    colour: STATUS_ERROR_COLOUR,
  },
  {
    name: '/verify on a deployment with no role list port',
    command: 'verify',
    options: [],
    config: GATED,
    arrange: (h) => {
      delete h.deps.guildState;
    },
    says: 'I can’t verify you right now. Nothing was changed, and it’s not anything you did.',
    colour: STATUS_ERROR_COLOUR,
  },
  {
    name: '/verify in a server with neither role chosen',
    command: 'verify',
    options: [],
    config: { enabled: true },
    says: "Verification isn't set up in this server yet.",
    colour: STATUS_ERROR_COLOUR,
  },
  {
    name: '/verify with the member role above Proton',
    command: 'verify',
    options: [],
    config: { ...GATED, verifiedRoleId: ABOVE_BOT_ROLE },
    says: 'An admin needs to move my role above it in Server Settings → Roles.',
    colour: STATUS_ERROR_COLOUR,
  },
  {
    name: '/verify from a member on the blocked list',
    command: 'verify',
    options: [],
    config: GATED,
    arrange: (h) => {
      unverified(h);
      h.deps.blocked = blockedList(MODERATOR);
    },
    says: 'blocked list',
    colour: STATUS_ERROR_COLOUR,
  },
  {
    name: '/verify when Discord refuses the grant',
    command: 'verify',
    options: [],
    config: GATED,
    arrange: (h) => {
      unverified(h);
      h.rest.fail(
        (call) => call.method === 'PUT' && call.path.endsWith(`/roles/${VERIFIED_ROLE}`),
        { status: 500, body: { message: 'Internal Server Error' } },
      );
    },
    says: "I couldn't finish verifying you, so nothing has changed",
    colour: STATUS_ERROR_COLOUR,
  },
  {
    name: '/verify that lets the member in',
    command: 'verify',
    options: [],
    config: GATED,
    arrange: unverified,
    says: "You're verified. Welcome in.",
    colour: STATUS_SUCCESS_COLOUR,
  },
  {
    name: '/verify that grants the member role but cannot clear the unverified one',
    command: 'verify',
    options: [],
    config: GATED,
    arrange: (h) => {
      unverified(h);
      h.rest.fail(
        (call) => call.method === 'DELETE' && call.path.endsWith(`/roles/${UNVERIFIED_ROLE}`),
        { status: 500, body: { message: 'Internal Server Error' } },
      );
    },
    says: "You're verified, but one step didn't finish.",
    colour: STATUS_SUCCESS_COLOUR,
  },
  {
    name: '/quarantine with a subcommand nobody knows',
    command: 'quarantine',
    options: subcommand('dance', []),
    config: QUARANTINED,
    says: 'Use /quarantine add to quarantine a member, or /quarantine remove to release them.',
    colour: STATUS_ERROR_COLOUR,
  },
  {
    name: '/quarantine add with nobody chosen',
    command: 'quarantine',
    options: subcommand('add', []),
    config: QUARANTINED,
    says: 'Choose the member to quarantine.',
    colour: STATUS_ERROR_COLOUR,
  },
  {
    name: '/quarantine remove with nobody chosen',
    command: 'quarantine',
    options: subcommand('remove', []),
    config: QUARANTINED,
    says: 'Choose the member to release from quarantine.',
    colour: STATUS_ERROR_COLOUR,
  },
  {
    name: '/quarantine add while verification is off',
    command: 'quarantine',
    options: add(),
    config: { enabled: false },
    says: 'Verification is off in this server, so quarantine isn’t available.',
    colour: STATUS_ERROR_COLOUR,
  },
  {
    name: '/quarantine add with no quarantine role chosen',
    command: 'quarantine',
    options: add(),
    config: { enabled: true },
    says: 'No quarantine role is set.',
    colour: STATUS_ERROR_COLOUR,
  },
  {
    name: '/quarantine add on a deployment with no quarantine store',
    command: 'quarantine',
    options: add(),
    config: QUARANTINED,
    arrange: (h) => {
      delete h.deps.quarantine;
    },
    says: 'I couldn’t quarantine that member. Nothing was changed.',
    colour: STATUS_ERROR_COLOUR,
  },
  {
    name: '/quarantine add before the role list has arrived',
    command: 'quarantine',
    options: add(),
    config: QUARANTINED,
    arrange: (h) => {
      const state = h.deps.guildState;
      if (state) h.deps.guildState = { ...state, get: async () => null };
    },
    says: "I haven't loaded this server's roles yet, so nothing was changed.",
    colour: STATUS_ERROR_COLOUR,
  },
  {
    name: '/quarantine add with the quarantine role above Proton',
    command: 'quarantine',
    options: add(),
    config: QUARANTINED,
    arrange: (h) => {
      h.positions.set(QUARANTINE_ROLE, 9);
    },
    says: 'move my role above it in Server Settings → Roles. Nothing was changed.',
    colour: STATUS_ERROR_COLOUR,
  },
  {
    name: '/quarantine add for somebody already quarantined',
    command: 'quarantine',
    options: add(),
    config: QUARANTINED,
    arrange: quarantined,
    says: `<@${MEMBER}> is already quarantined`,
    colour: STATUS_ERROR_COLOUR,
  },
  {
    name: '/quarantine add for somebody whose roles cannot be read',
    command: 'quarantine',
    options: add(STRANGER),
    config: QUARANTINED,
    says: `I couldn't read <@${STRANGER}>'s roles, so I didn't quarantine them.`,
    colour: STATUS_ERROR_COLOUR,
  },
  {
    name: '/quarantine add that lands',
    command: 'quarantine',
    options: add(),
    config: QUARANTINED,
    says: `Quarantined <@${MEMBER}>.`,
    colour: STATUS_SUCCESS_COLOUR,
  },
  {
    name: '/quarantine add that lands only partly',
    command: 'quarantine',
    options: add(),
    config: QUARANTINED,
    arrange: (h) => {
      h.rest.fail((call) => call.method === 'DELETE' && call.path.endsWith(`/roles/${LOW_ROLE}`), {
        status: 500,
        body: { message: 'Internal Server Error' },
      });
    },
    says: `Quarantined <@${MEMBER}>, but some steps failed.`,
    colour: STATUS_ERROR_COLOUR,
  },
  {
    name: '/quarantine remove with no record',
    command: 'quarantine',
    options: remove(),
    config: QUARANTINED,
    says: `I have no quarantine record for <@${MEMBER}>`,
    colour: STATUS_ERROR_COLOUR,
  },
  {
    name: '/quarantine remove that lands',
    command: 'quarantine',
    options: remove(),
    config: QUARANTINED,
    arrange: quarantined,
    says: 'The quarantine record was cleared.',
    colour: STATUS_SUCCESS_COLOUR,
  },
  {
    name: '/quarantine remove that has to keep the record',
    command: 'quarantine',
    options: remove(),
    config: QUARANTINED,
    arrange: async (h) => {
      await quarantined(h);
      h.positions.delete(MID_ROLE);
    },
    says: 'I kept the quarantine record so nothing is lost.',
    colour: STATUS_ERROR_COLOUR,
  },
];

interface Work {
  early: string[];
  done: string[];
}

function watchWork(h: Harness): Work {
  const work: Work = { early: [], done: [] };
  const note = (what: string): void => {
    work.done.push(what);
    if (!h.callbackTypes().includes(INTERACTION_CALLBACK_DEFERRED_MESSAGE)) work.early.push(what);
  };

  const { guildState, fetchMemberRoles, quarantine, blocked } = h.deps;

  if (guildState) {
    h.deps.guildState = {
      ...guildState,
      get: async (guildId) => {
        note('guildState.get');
        return guildState.get(guildId);
      },
    };
  }

  if (fetchMemberRoles) {
    h.deps.fetchMemberRoles = async (guildId, userId) => {
      note('fetchMemberRoles');
      return fetchMemberRoles(guildId, userId);
    };
  }

  if (quarantine) {
    h.deps.quarantine = {
      get: async (guildId, userId) => {
        note('quarantine.get');
        return quarantine.get(guildId, userId);
      },
      put: async (entry) => {
        note('quarantine.put');
        return quarantine.put(entry);
      },
      clear: async (guildId, userId) => {
        note('quarantine.clear');
        return quarantine.clear(guildId, userId);
      },
    };
  }

  if (blocked) {
    h.deps.blocked = {
      block: (input) => blocked.block(input),
      find: async (guildId, userId) => {
        note('blocked.find');
        return blocked.find(guildId, userId);
      },
      list: (guildId, query) => blocked.list(guildId, query),
      lift: (input) => blocked.lift(input),
    };
  }

  return work;
}

async function prepare(entry: Case): Promise<Harness> {
  const h = harness();
  if (entry.command === 'verify') h.deps.blocked = blockedList();
  await entry.arrange?.(h);

  return h;
}

async function perform(entry: Case, withApplication: boolean): Promise<Harness> {
  const h = await prepare(entry);

  if (withApplication) {
    await h.run(entry.command, entry.options, { config: entry.config });
  } else {
    delete h.deps.applicationId;
    await h.run(entry.command, entry.options, { config: entry.config, applicationId: null });
  }

  return h;
}

function bodyOf(call: { body?: unknown } | undefined): Record<string, unknown> {
  return (call?.body ?? {}) as Record<string, unknown>;
}

describe('/verify and /quarantine acknowledge each interaction exactly once', () => {
  for (const entry of cases) {
    test(`${entry.name}: one private defer before any work, then one private followup`, async () => {
      const h = await prepare(entry);
      const work = watchWork(h);

      await h.run(entry.command, entry.options, { config: entry.config });

      expect(h.callbackTypes()).toEqual([INTERACTION_CALLBACK_DEFERRED_MESSAGE]);
      expect(h.rest.calls[0]?.path).toBe(CALLBACK_PATH);
      expect(bodyOf(h.rest.calls[0])).toEqual({
        type: INTERACTION_CALLBACK_DEFERRED_MESSAGE,
        data: { flags: MESSAGE_FLAG_EPHEMERAL },
      });
      expect(work.early).toEqual([]);

      const followups = h.followups();
      expect(followups).toHaveLength(1);
      expect(followups[0]?.path).toBe(FOLLOWUP_PATH);
      expect(bodyOf(followups[0]).flags).toBe(MESSAGE_FLAG_EPHEMERAL);

      expect(h.lastStatus()?.description).toContain(entry.says);
      expect(h.lastStatus()?.color).toBe(entry.colour);
    });

    test(`${entry.name}: without an application id, the one callback is the same answer`, async () => {
      const fallback = await perform(entry, false);

      expect(fallback.callbackTypes()).toEqual([INTERACTION_CALLBACK_CHANNEL_MESSAGE]);
      expect(fallback.followups()).toEqual([]);

      const callback = bodyOf(fallback.callbacks()[0]);
      const said = callback.data as Record<string, unknown>;
      expect(said.flags).toBe(MESSAGE_FLAG_EPHEMERAL);
      expect(fallback.lastStatus()?.description).toContain(entry.says);
      expect(fallback.lastStatus()?.color).toBe(entry.colour);

      const deferred = await perform(entry, true);
      expect(bodyOf(deferred.followups()[0])).toEqual(said);
    });
  }

  test('/verify reads the blocked list, and only once it has deferred', async () => {
    const h = harness();
    h.deps.blocked = blockedList();
    unverified(h);
    const work = watchWork(h);

    await h.run('verify', [], { config: GATED });

    expect(work.done).toContain('blocked.find');
    expect(work.early).toEqual([]);
    expect(h.lastStatus()?.description).toContain("You're verified. Welcome in.");
  });
});

describe('where the followup webhook comes from', () => {
  test('the interaction’s own application id is enough when the module was built without one', async () => {
    const h = harness();
    delete h.deps.applicationId;
    unverified(h);

    await h.run('verify', [], { config: GATED });

    expect(h.callbackTypes()).toEqual([INTERACTION_CALLBACK_DEFERRED_MESSAGE]);
    expect(h.followups().map((call) => call.path)).toEqual([FOLLOWUP_PATH]);
  });

  test('the module’s application id stands in when the interaction carried none', async () => {
    const h = harness();

    await h.run('quarantine', add(), { config: QUARANTINED, applicationId: null });

    expect(h.callbackTypes()).toEqual([INTERACTION_CALLBACK_DEFERRED_MESSAGE]);
    expect(h.followups().map((call) => call.path)).toEqual([FOLLOWUP_PATH]);
  });

  test('the interaction’s application id wins over the module’s', async () => {
    const h = harness();

    await h.run('quarantine', add(), { config: QUARANTINED, applicationId: OTHER_APPLICATION });

    expect(h.followups().map((call) => call.path)).toEqual([
      `/webhooks/${OTHER_APPLICATION}/${INTERACTION_TOKEN}`,
    ]);
  });
});

describe('/verify never answers with a modal', () => {
  for (const [what, config] of [
    ['button', GATED],
    ['captcha', CAPTCHA],
    ['website', WEBSITE],
  ] as const) {
    test(`in ${what} mode it defers, and opens nothing`, async () => {
      const h = harness();
      unverified(h);

      await h.run('verify', [], { config });

      expect(h.callbackTypes()).toEqual([INTERACTION_CALLBACK_DEFERRED_MESSAGE]);
      expect(h.modalOpened()).toBeNull();
      expect(h.followups()).toHaveLength(1);
    });
  }
});

describe('a redelivered command', () => {
  test('/verify reaches Discord once: one defer, one followup, one set of role calls', async () => {
    const h = harness();
    unverified(h);

    await h.run('verify', [], { config: GATED, idempotencyKey: 'event-verify' });
    const roleCalls = h.roleCalls().length;
    await h.run('verify', [], { config: GATED, idempotencyKey: 'event-verify' });

    expect(h.callbackTypes()).toEqual([INTERACTION_CALLBACK_DEFERRED_MESSAGE]);
    expect(h.followups()).toHaveLength(1);
    expect(h.roleCalls()).toHaveLength(roleCalls);
  });

  test('/quarantine add does not follow its own success with “already quarantined”', async () => {
    const h = harness();

    await h.run('quarantine', add(), { config: QUARANTINED, idempotencyKey: 'event-quarantine' });
    await h.run('quarantine', add(), { config: QUARANTINED, idempotencyKey: 'event-quarantine' });

    expect(h.callbackTypes()).toEqual([INTERACTION_CALLBACK_DEFERRED_MESSAGE]);
    expect(h.followups()).toHaveLength(1);
    expect(h.lastStatus()?.description).toContain(`Quarantined <@${MEMBER}>.`);
  });
});

const RENAMED = (key: string, path?: string) =>
  formatCommandLabel(key, path, key === 'quarantine' ? 'jail' : undefined);

describe('/quarantine names its commands the way this server shows them', () => {
  test('an unknown subcommand points at both renamed subcommands', async () => {
    const h = harness();

    await h.run('quarantine', subcommand('dance', []), {
      config: QUARANTINED,
      commandLabel: RENAMED,
    });

    expect(h.lastStatus()?.description).toContain(
      'Use /jail add to quarantine a member, or /jail remove to release them.',
    );
  });

  test('a quarantine that lands says to run the renamed remove', async () => {
    const h = harness();

    await h.run('quarantine', add(), { config: QUARANTINED, commandLabel: RENAMED });

    const said = h.lastStatus()?.description ?? '';
    expect(said).toContain('Run /jail remove to restore them.');
    expect(said).not.toContain('/quarantine');
  });

  test('somebody already quarantined is pointed at the renamed remove', async () => {
    const h = harness();
    await quarantined(h);

    await h.run('quarantine', add(), { config: QUARANTINED, commandLabel: RENAMED });

    expect(h.lastStatus()?.description).toContain(
      'to give back. Run /jail remove to restore them.',
    );
  });

  test('a release that has to keep the record says to run the renamed remove again', async () => {
    const h = harness();
    await quarantined(h);
    h.positions.delete(MID_ROLE);

    await h.run('quarantine', remove(), { config: QUARANTINED, commandLabel: RENAMED });

    expect(h.lastStatus()?.description).toContain(
      'Fix the problems above and run /jail remove again. Roles they already have are skipped.',
    );
  });

  test('without a label source the copy names /quarantine remove as it always has', async () => {
    const h = harness();

    await h.run('quarantine', add(), { config: QUARANTINED });

    expect(h.lastStatus()?.description).toContain('Run /quarantine remove to restore them.');
  });
});

describe('the manifest', () => {
  test('declares interaction_followup, which every deferred command answer is sent as', () => {
    expect(verificationModule.actionKinds).toContain('interaction_followup');
  });
});
