import { describe, expect, test } from 'bun:test';
import {
  ADMIN_ROLE,
  armed,
  GUILD,
  harness,
  LOW_ROLE,
  MEMBER,
  OWNER,
  STAFF_ROLE,
  TRAP,
} from './harness.ts';

const EXEMPT_ADMINS = armed({ exemptAdministrators: true });

describe('a member nothing exempts', () => {
  test('is acted on exactly as before', async () => {
    const h = harness();

    const outcome = await h.trip({ config: EXEMPT_ADMINS, roleIds: [LOW_ROLE] });

    expect(outcome).toEqual({ action: 'sprung', kind: 'softban' });
    expect(h.requests().filter((r) => r.kind === 'ban')).toHaveLength(1);
  });
});

describe('exempt administrators', () => {
  test('is on by default, so a fresh honeypot never bans an admin', async () => {
    const h = harness();

    const outcome = await h.trip({ config: armed(), roleIds: [ADMIN_ROLE] });

    expect(outcome).toEqual({ action: 'exempt', reason: 'administrator' });
  });

  // Nothing reached the executor, so nothing may look like it was attempted and refused.
  test('touches Discord not at all', async () => {
    const h = harness();

    await h.trip({ config: EXEMPT_ADMINS, roleIds: [ADMIN_ROLE] });

    expect(h.requests().map((r) => r.kind)).toEqual([]);
  });

  test('covers the guild owner, who holds every permission without a role saying so', async () => {
    const h = harness();

    const outcome = await h.trip({
      config: EXEMPT_ADMINS,
      authorId: OWNER,
      roleIds: [],
    });

    expect(outcome).toEqual({ action: 'exempt', reason: 'administrator' });
  });

  test('switched off, an administrator is caught like anyone else', async () => {
    const h = harness();

    const outcome = await h.trip({
      config: armed({ exemptAdministrators: false }),
      roleIds: [ADMIN_ROLE],
    });

    expect(outcome).toEqual({ action: 'sprung', kind: 'softban' });
  });
});

describe('the exempt roles', () => {
  test('the named admin role is exempt', async () => {
    const h = harness();

    const outcome = await h.trip({
      config: armed({ exemptAdministrators: false, exemptAdminRoleId: STAFF_ROLE }),
      roleIds: [STAFF_ROLE],
    });

    expect(outcome).toEqual({ action: 'exempt', reason: 'admin_role' });
  });

  test('any role on the exempt list is exempt', async () => {
    const h = harness();

    const outcome = await h.trip({
      config: armed({ exemptAdministrators: false, exemptRoleIds: [STAFF_ROLE] }),
      roleIds: [LOW_ROLE, STAFF_ROLE],
    });

    expect(outcome).toEqual({ action: 'exempt', reason: 'role' });
  });

  test('a role that is not on the list is not exempt', async () => {
    const h = harness();

    const outcome = await h.trip({
      config: armed({ exemptAdministrators: false, exemptRoleIds: [STAFF_ROLE] }),
      roleIds: [LOW_ROLE],
    });

    expect(outcome).toEqual({ action: 'sprung', kind: 'softban' });
  });
});

// The worst thing this module can do is act on somebody it should not have, and a member whose
// roles it cannot read is exactly the case where it cannot tell.
describe('a member whose roles Proton cannot read', () => {
  test('is left alone when any exemption is configured', async () => {
    const h = harness();

    const outcome = await h.trip({
      config: EXEMPT_ADMINS,
      withoutMember: true,
    });

    expect(outcome).toEqual({ action: 'exempt', reason: 'unknown_roles' });
    expect(h.requests().map((r) => r.kind)).toEqual([]);
  });

  test('is caught when no exemption is configured at all, because none can be missed', async () => {
    const h = harness();

    const outcome = await h.trip({
      config: armed({ exemptAdministrators: false }),
      withoutMember: true,
    });

    expect(outcome).toEqual({ action: 'sprung', kind: 'softban' });
  });
});

describe('what an exempt catch still does', () => {
  test('reaches the log channel, marked as left alone rather than as a failure', async () => {
    const h = harness();

    await h.trip({
      config: { ...EXEMPT_ADMINS, logChannelId: TRAP },
      roleIds: [ADMIN_ROLE],
    });

    const embed = JSON.stringify(h.embedIn(TRAP));

    expect(embed).toContain('Left alone');
    expect(embed).toContain('they hold Administrator');
  });

  test('is counted, so the trap’s tally does not silently lose them', async () => {
    const h = harness();

    await h.trip({ config: EXEMPT_ADMINS, roleIds: [ADMIN_ROLE] });

    expect(h.stats.caught(GUILD, TRAP).map((entry) => entry.action)).toEqual(['exempt']);
  });

  // The button over a bait channel prints the lifetime total. Counting staff nobody touched would
  // make it overstate what the trap has ever actually done.
  test('does not move the number on the public counter button', async () => {
    const h = harness();

    await h.trip({ config: EXEMPT_ADMINS, roleIds: [ADMIN_ROLE] });

    expect(await h.stats.total(GUILD, TRAP)).toBe(0);
    expect(h.stats.caught(GUILD, TRAP)).toHaveLength(1);
  });

  test('still shows in the breakdown a moderator reads', async () => {
    const h = harness();

    await h.trip({ config: EXEMPT_ADMINS, roleIds: [ADMIN_ROLE] });

    const read = await h.stats.read(GUILD, TRAP, h.now());

    expect(read.byAction.exempt).toBe(1);
    expect(read.total).toBe(0);
  });

  test('a burst from one exempt member is one catch, not three', async () => {
    const h = harness();

    for (const messageId of ['1', '2', '3']) {
      await h.trip({ config: EXEMPT_ADMINS, roleIds: [ADMIN_ROLE], messageId });
    }

    expect(h.stats.caught(GUILD, TRAP)).toHaveLength(1);
  });

  test('names the member and the reason in the log', async () => {
    const h = harness();

    await h.trip({ config: EXEMPT_ADMINS, roleIds: [ADMIN_ROLE] });

    expect(h.said('info').join(' ')).toContain(MEMBER);
    expect(h.said('info').join(' ')).toContain('left alone');
  });
});
