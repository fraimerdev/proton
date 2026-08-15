import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Permissions } from '@proton/core';
import { ANTINUKE_ACTOR } from '../src/breaker.ts';
import {
  ALERT_CHANNEL,
  auditEvent,
  BOT_PERMISSIONS,
  EVERYONE_ROLE,
  type FakeRateWindow,
  GUILD,
  type HarnessOptions,
  harness,
  NUKER,
  NUKER_HIGH_ROLE,
  NUKER_LOW_ROLE,
  OWNER,
} from './harness.ts';

const ORIGINAL_ENV = process.env.NODE_ENV;

// The ordering these tests exist to prove is only observable when the
// destructive half actually reaches Discord. I12 holds it back everywhere but
// production, so production is what they run as; the dry-run behaviour itself is
// pinned by its own test at the bottom.
beforeAll(() => {
  process.env.NODE_ENV = 'production';
});

afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_ENV;
});

/** A harness whose window is already over the limit, so the next event trips it. */
function tripped(options: HarnessOptions = {}) {
  const h = harness(options);
  const window = h.rateWindow as FakeRateWindow;
  window.tripped = true;
  window.count = 3;
  return h;
}

describe('the breaker', () => {
  test('strips every removable role before anything destructive happens', async () => {
    const h = tripped();

    const outcome = await h.handle(auditEvent('channel.deleted'), {
      afterStrip: 'ban',
      alertChannelId: ALERT_CHANNEL,
    });

    expect(outcome.action).toBe('tripped');
    expect(h.callPaths()).toEqual([
      // Highest position first: if Discord rate-limits us partway through, the
      // role carrying the dangerous permissions is already gone.
      `DELETE /guilds/${GUILD}/members/${NUKER}/roles/${NUKER_HIGH_ROLE}`,
      `DELETE /guilds/${GUILD}/members/${NUKER}/roles/${NUKER_LOW_ROLE}`,
      `PUT /guilds/${GUILD}/bans/${NUKER}`,
      `POST /channels/${ALERT_CHANNEL}/messages`,
    ]);
  });

  test('never tries to remove @everyone, which Discord refuses', async () => {
    const h = tripped();

    await h.handle(auditEvent('channel.deleted'));

    // The member holds three roles in the harness and only two are removable —
    // @everyone's id is the guild id, and Discord rejects removing it.
    expect(h.callPaths()).toHaveLength(2);
    expect(h.callPaths().some((path) => path.endsWith(`/roles/${EVERYONE_ROLE}`))).toBe(false);
  });

  test('does nothing irreversible unless the guild asked for it', async () => {
    const h = tripped();

    // `afterStrip` defaults to none: the reversible half runs, and a human
    // decides the rest.
    await h.handle(auditEvent('channel.deleted'), { alertChannelId: ALERT_CHANNEL });

    expect(h.callPaths()).toEqual([
      `DELETE /guilds/${GUILD}/members/${NUKER}/roles/${NUKER_HIGH_ROLE}`,
      `DELETE /guilds/${GUILD}/members/${NUKER}/roles/${NUKER_LOW_ROLE}`,
      `POST /channels/${ALERT_CHANNEL}/messages`,
    ]);
    expect(h.alertContent()).toContain('Nothing else was done');
  });

  test('records the whole stripped set on every case, so a restore is exact', async () => {
    const h = tripped();

    await h.handle(auditEvent('channel.deleted'));

    const cases = h.cases();
    expect(cases).toHaveLength(2);
    for (const recorded of cases) {
      expect(recorded.kind).toBe('remove_role');
      expect(recorded.moduleId).toBe('antinuke');
      expect(recorded.targetId).toBe(NUKER);
      // Nobody pressed a button, so the ledger must not name a person.
      expect(recorded.actorId).toBe(ANTINUKE_ACTOR);
      expect(recorded.reason).toContain('Anti-nuke: 3 channel deletions within 30s');
      expect(recorded.payload).toMatchObject({
        userId: NUKER,
        strippedRoleIds: [NUKER_HIGH_ROLE, NUKER_LOW_ROLE],
      });
    }
  });

  test('handles the same audit entry twice without stripping twice (I4)', async () => {
    const h = tripped();
    const event = auditEvent('channel.deleted');

    await h.handle(event);
    const before = h.rest.calls.length;
    // A gateway RESUME redelivers the entry; the derived event id is identical.
    await h.handle(event);

    expect(h.rest.calls).toHaveLength(before);
  });

  test('tells the guild what it did, in numbers an admin can act on', async () => {
    const h = tripped();

    await h.handle(auditEvent('channel.deleted'), { alertChannelId: ALERT_CHANNEL });

    const alert = h.alertContent() ?? '';
    expect(alert).toContain('Anti-nuke tripped');
    expect(alert).toContain('3 channel deletions within 30s');
    expect(alert).toContain(NUKER);
    expect(alert).toContain(NUKER_HIGH_ROLE);
    expect(alert).toContain('restored exactly');
  });
});

describe('the guild owner', () => {
  test('is never acted on, and the guild is told why rather than left guessing', async () => {
    const h = tripped();

    const outcome = await h.handle(auditEvent('channel.deleted', { actorId: OWNER }), {
      afterStrip: 'ban',
      alertChannelId: ALERT_CHANNEL,
    });

    expect(outcome).toMatchObject({ action: 'tripped', report: { ownerExempt: true } });
    // The alert is the only call: no role removal, no ban, not even an attempt.
    expect(h.callPaths()).toEqual([`POST /channels/${ALERT_CHANNEL}/messages`]);
    expect(h.cases().map((recorded) => recorded.kind)).toEqual(['send']);
    expect(h.alertContent()).toContain('owns this server');
    expect(h.logged('warn', 'Discord does not let')).toBe(true);
  });
});

describe('when Proton cannot do its half', () => {
  test('names the missing permission and where, instead of failing silently', async () => {
    // The guild took MANAGE_ROLES off the bot's role — the commonest cause of
    // "anti-nuke did nothing" in the wild. Everything else is left intact, so
    // the breaker can still report what it could not do.
    const h = tripped({ botPermissions: BOT_PERMISSIONS & ~Permissions.ManageRoles });

    await h.handle(auditEvent('channel.deleted'), { alertChannelId: ALERT_CHANNEL });

    const alert = h.alertContent() ?? '';
    expect(alert).toContain('What did NOT work');
    expect(alert).toContain('ManageRoles');
    expect(alert).toContain(`guild ${GUILD}`);
    // Nothing was removed, so nothing is recorded as removed.
    expect(h.cases().map((recorded) => recorded.kind)).toEqual(['send']);
  });

  test('stops rather than escalating when it cannot read the actor roles', async () => {
    // Fails closed: with the reversible half unavailable, performing only the
    // irreversible half inverts the entire point of the ordering.
    const h = tripped({ memberRoles: {} });

    const outcome = await h.handle(auditEvent('channel.deleted'), {
      afterStrip: 'ban',
      alertChannelId: ALERT_CHANNEL,
    });

    expect(outcome).toMatchObject({ action: 'tripped', report: { strippedRoleIds: [] } });
    // No strip, and — the point of the test — no ban either.
    expect(h.callPaths()).toEqual([`POST /channels/${ALERT_CHANNEL}/messages`]);
    expect(h.alertContent()).toContain('could not read that member');
    expect(h.logged('error', 'this one needs a person')).toBe(true);
  });

  test('reports its own inability to reach the alert channel', async () => {
    const h = tripped();
    h.rest.response = { status: 403, body: { message: 'Missing Access' } };

    await h.handle(auditEvent('channel.deleted'), { alertChannelId: ALERT_CHANNEL });

    expect(h.logged('error', 'could not post to its alert channel')).toBe(true);
  });
});

describe('I12 in development', () => {
  const DEV_ENV = 'development';

  beforeEach(() => {
    process.env.NODE_ENV = DEV_ENV;
  });

  afterAll(() => {
    process.env.NODE_ENV = 'production';
  });

  test('strips for real but holds the ban back, recording what it would have done', async () => {
    const h = tripped();

    await h.handle(auditEvent('channel.deleted'), { afterStrip: 'ban' });

    // The strip is not destructive by core's own list, and withholding it would
    // make anti-nuke a no-op everywhere but production.
    expect(h.callPaths()).toEqual([
      `DELETE /guilds/${GUILD}/members/${NUKER}/roles/${NUKER_HIGH_ROLE}`,
      `DELETE /guilds/${GUILD}/members/${NUKER}/roles/${NUKER_LOW_ROLE}`,
    ]);

    const ban = h.cases().find((recorded) => recorded.kind === 'ban');
    expect(ban?.dryRun).toBe(true);
  });
});
