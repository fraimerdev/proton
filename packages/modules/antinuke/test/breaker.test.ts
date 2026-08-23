import { describe, expect, test } from 'bun:test';
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
      `DELETE /guilds/${GUILD}/members/${NUKER}/roles/${NUKER_HIGH_ROLE}`,
      `DELETE /guilds/${GUILD}/members/${NUKER}/roles/${NUKER_LOW_ROLE}`,
      `PUT /guilds/${GUILD}/bans/${NUKER}`,
      `POST /channels/${ALERT_CHANNEL}/messages`,
    ]);
  });

  test('never tries to remove @everyone, which Discord refuses', async () => {
    const h = tripped();

    await h.handle(auditEvent('channel.deleted'));

    expect(h.callPaths()).toHaveLength(2);
    expect(h.callPaths().some((path) => path.endsWith(`/roles/${EVERYONE_ROLE}`))).toBe(false);
  });

  test('does nothing irreversible unless the guild asked for it', async () => {
    const h = tripped();

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

    expect(h.callPaths()).toEqual([`POST /channels/${ALERT_CHANNEL}/messages`]);
    expect(h.cases().map((recorded) => recorded.kind)).toEqual(['send']);
    expect(h.alertContent()).toContain('owns this server');
    expect(h.logged('warn', 'Discord does not let')).toBe(true);
  });
});

describe('when Proton cannot do its half', () => {
  test('names the missing permission and where, instead of failing silently', async () => {
    const h = tripped({ botPermissions: BOT_PERMISSIONS & ~Permissions.ManageRoles });

    await h.handle(auditEvent('channel.deleted'), { alertChannelId: ALERT_CHANNEL });

    const alert = h.alertContent() ?? '';
    expect(alert).toContain('What did NOT work');
    expect(alert).toContain('ManageRoles');
    expect(alert).toContain(`guild ${GUILD}`);

    expect(h.cases().map((recorded) => recorded.kind)).toEqual(['send']);
  });

  test('stops rather than escalating when it cannot read the actor roles', async () => {
    const h = tripped({ memberRoles: {} });

    const outcome = await h.handle(auditEvent('channel.deleted'), {
      afterStrip: 'ban',
      alertChannelId: ALERT_CHANNEL,
    });

    expect(outcome).toMatchObject({ action: 'tripped', report: { strippedRoleIds: [] } });

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

describe('the ban that follows a strip', () => {
  test('is performed for real, after the roles are already off', async () => {
    const h = tripped();

    await h.handle(auditEvent('channel.deleted'), { afterStrip: 'ban' });

    expect(h.callPaths()).toEqual([
      `DELETE /guilds/${GUILD}/members/${NUKER}/roles/${NUKER_HIGH_ROLE}`,
      `DELETE /guilds/${GUILD}/members/${NUKER}/roles/${NUKER_LOW_ROLE}`,
      `PUT /guilds/${GUILD}/bans/${NUKER}`,
    ]);

    const ban = h.cases().find((recorded) => recorded.kind === 'ban');
    expect(ban?.dryRun).toBe(false);
  });
});
