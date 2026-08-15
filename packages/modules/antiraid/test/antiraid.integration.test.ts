import { describe, expect, test } from 'bun:test';
import { Permissions } from '@proton/core';
import type { AntiraidConfig } from '../src/config.ts';
import {
  ALERT_CHANNEL,
  accountId,
  BOT_PERMISSIONS,
  GUILD,
  HIGH_ROLE,
  harness,
  QUARANTINE_ROLE,
  VERIFY_ROLE,
} from './harness.ts';

const DAY = 24 * 60 * 60 * 1000;
const RAID_START = Date.parse('2026-08-14T09:00:00.000Z');

/** Quarantine, alerting, everything on — the shape a protected guild runs. */
const PROTECTED: Partial<AntiraidConfig> = {
  enabled: true,
  response: 'quarantine',
  quarantineRoleId: QUARANTINE_ROLE,
  alertChannelId: ALERT_CHANNEL,
};

/** Accounts a few days old with no avatar: two signals, one short of acting. */
function raider(index: number, at: number) {
  return { userId: accountId(RAID_START - 3 * DAY + index), joinedAt: at, avatar: null };
}

/** A year old, has an avatar. The member a false positive would lock out. */
function regular(index: number, at: number) {
  return {
    userId: accountId(RAID_START - 365 * DAY + index),
    joinedAt: at,
    avatar: 'a_1234567890abcdef',
  };
}

function messageCalls(h: ReturnType<typeof harness>) {
  return h.calls().filter((call) => call.path.endsWith('/messages'));
}

describe('a burst above the threshold', () => {
  test('quarantines the accounts that cross it, and alerts once', async () => {
    const h = harness();

    // Twelve joins in 3.3s against a default window of 10 joins per 10s.
    for (let i = 0; i < 12; i++) {
      await h.join(raider(i, RAID_START + i * 300), { config: PROTECTED });
    }

    // The first nine scored 2 — new account plus no avatar — and were let
    // through, because two thirds of a heuristic is not evidence. The tenth join
    // filled the window, and from there the burst signal takes the same accounts
    // to 4.
    expect(h.memberCalls()).toHaveLength(3);
    expect(h.memberCalls()[0]?.method).toBe('PUT');
    expect(h.memberCalls()[0]?.path).toBe(
      `/guilds/${GUILD}/members/${accountId(RAID_START - 3 * DAY + 9)}/roles/${QUARANTINE_ROLE}`,
    );

    // One alert for the raid, not one per raider: `tripped` is true on exactly
    // the join that crossed the threshold.
    expect(messageCalls(h)).toHaveLength(1);
    expect(h.alertContent()).toContain('Raid mode');
    expect(h.alertContent()).toContain('10 accounts joined within 10s');
    expect(h.alertContent()).toContain('being quarantined for staff review');
  });

  test('records why, in the words the member and the audit log get', async () => {
    const h = harness();
    for (let i = 0; i < 10; i++) {
      await h.join(raider(i, RAID_START + i * 300), { config: PROTECTED });
    }

    const acted = h.cases().find((c) => c.kind === 'add_role');
    expect(acted?.moduleId).toBe('antiraid');
    expect(acted?.actorId).toBe('proton:antiraid');
    expect(acted?.reason).toContain('Anti-raid 4/5');
    expect(acted?.reason).toContain('10 accounts joined within 10s');
    expect(acted?.reason).toContain('The account has no avatar.');
  });

  /**
   * The false positive that matters most. A long-standing member with an avatar
   * who happens to join during a raid contributes only the burst signal, and one
   * signal is never enough — see `MIN_ACTIONABLE_SCORE`.
   */
  test('lets an established account through even mid-raid, and says it did', async () => {
    const h = harness();
    for (let i = 0; i < 10; i++) {
      await h.join(raider(i, RAID_START + i * 300), { config: PROTECTED });
    }
    h.rest.calls.length = 0;

    await h.join(regular(0, RAID_START + 3300), { config: PROTECTED });

    expect(h.memberCalls()).toHaveLength(0);
    expect(h.logs.some((line) => line.message.includes('let through'))).toBe(true);
  });
});

describe('a legitimate join wave', () => {
  /**
   * The failure mode this module is most likely to have in the wild: a server
   * gets linked somewhere popular and grows, and an over-eager anti-raid locks
   * out the members it just gained.
   */
  test('under the threshold is never acted on, however long it runs', async () => {
    const h = harness();

    // Twenty new, avatarless accounts — every heuristic short of the rate — two
    // seconds apart, so the 10s window never holds more than six.
    for (let i = 0; i < 20; i++) {
      await h.join(raider(i, RAID_START + i * 2000), { config: PROTECTED });
    }

    expect(h.memberCalls()).toHaveLength(0);
    expect(messageCalls(h)).toHaveLength(0);
    expect(h.cases()).toHaveLength(0);
  });

  test('nine joins inside the window stay one short of tripping it', async () => {
    const h = harness();
    for (let i = 0; i < 9; i++) {
      await h.join(raider(i, RAID_START + i * 300), { config: PROTECTED });
    }

    expect(h.memberCalls()).toHaveLength(0);
    expect(messageCalls(h)).toHaveLength(0);
  });
});

describe('the response ladder', () => {
  test('verify applies the verification role and nothing else', async () => {
    const h = harness();
    const config: Partial<AntiraidConfig> = {
      enabled: true,
      response: 'verify',
      verificationRoleId: VERIFY_ROLE,
    };

    for (let i = 0; i < 10; i++) await h.join(raider(i, RAID_START + i * 300), { config });

    expect(h.memberCalls()).toHaveLength(1);
    expect(h.memberCalls()[0]?.path).toContain(`/roles/${VERIFY_ROLE}`);
  });

  /** I12: a kick is destructive, so outside production it is recorded, not performed. */
  test('kick is withheld outside production, and the alert says so', async () => {
    const h = harness();
    const config: Partial<AntiraidConfig> = {
      enabled: true,
      response: 'kick',
      alertChannelId: ALERT_CHANNEL,
    };

    for (let i = 0; i < 10; i++) await h.join(raider(i, RAID_START + i * 300), { config });

    expect(h.memberCalls()).toHaveLength(0);
    const kick = h.cases().find((c) => c.kind === 'kick');
    expect(kick?.dryRun).toBe(true);
    expect(kick?.targetId).toBe(accountId(RAID_START - 3 * DAY + 9));
    // The one thing an alert must never be wrong about mid-raid.
    expect(h.alertContent()).toContain('Nothing is actually being removed');
  });

  test('a rung with no role configured names the setting and the page', async () => {
    const h = harness();
    // `verify` is the default rung and needs a role the guild has to create.
    const config: Partial<AntiraidConfig> = { enabled: true, response: 'verify' };

    for (let i = 0; i < 10; i++) await h.join(raider(i, RAID_START + i * 300), { config });

    expect(h.memberCalls()).toHaveLength(0);
    const error = h.logs.find((line) => line.level === 'error');
    expect(error?.message).toContain('a verification role');
    expect(error?.message).toContain('Anti-raid page of the Proton dashboard');
  });
});

describe('failure paths', () => {
  test('a missing MANAGE_ROLES is named, with where it is missing', async () => {
    const h = harness();

    for (let i = 0; i < 10; i++) {
      await h.join(raider(i, RAID_START + i * 300), {
        config: PROTECTED,
        // Everything except the permission the quarantine rung needs.
        botPermissions: BOT_PERMISSIONS & ~Permissions.ManageRoles,
      });
    }

    expect(h.memberCalls()).toHaveLength(0);
    const warning = h.logs.find((line) => line.level === 'warn');
    expect(warning?.message).toContain('ManageRoles');
    expect(warning?.message).toContain(`guild ${GUILD}`);
    // The alert still goes out: raid protection failing is exactly when staff
    // most need to be told.
    expect(h.alertContent()).toContain('Raid mode');
  });

  test('a member above the bot is refused by the hierarchy precheck, not acted on', async () => {
    const h = harness();
    const staff = accountId(RAID_START - 3 * DAY + 9);

    for (let i = 0; i < 10; i++) {
      await h.join(raider(i, RAID_START + i * 300), {
        config: PROTECTED,
        memberRoles: { [staff]: [HIGH_ROLE] },
      });
    }

    expect(h.memberCalls()).toHaveLength(0);
    expect(h.logs.find((line) => line.level === 'warn')?.message).toContain(
      'above or equal to mine',
    );
  });
});

describe('redelivery', () => {
  /** I4: RESUME replays dispatches, so every join arrives at least twice. */
  test('the same join twice is counted once and acted on once', async () => {
    const h = harness();

    for (let i = 0; i < 10; i++) {
      const join = raider(i, RAID_START + i * 300);
      await h.join(join, { config: PROTECTED });
      // Byte-identical redelivery: same user, same joined_at, so the normaliser
      // would derive the same event id.
      await h.join(join, { config: PROTECTED });
    }

    expect(h.memberCalls()).toHaveLength(1);
    expect(messageCalls(h)).toHaveLength(1);
  });
});

describe('what is deliberately ignored', () => {
  test('a disabled module touches nothing, which is the default', async () => {
    const h = harness();
    for (let i = 0; i < 20; i++) await h.join(raider(i, RAID_START + i * 300));

    expect(h.calls()).toHaveLength(0);
    expect(h.logs).toHaveLength(0);
  });

  test('bots are skipped, and do not count towards the join rate', async () => {
    const h = harness();

    for (let i = 0; i < 9; i++) {
      await h.join({ ...raider(i, RAID_START + i * 300), bot: true }, { config: PROTECTED });
    }
    // A tenth join that would have crossed the threshold had the bots counted.
    await h.join(raider(9, RAID_START + 2700), { config: PROTECTED });

    expect(h.calls()).toHaveLength(0);
  });
});
