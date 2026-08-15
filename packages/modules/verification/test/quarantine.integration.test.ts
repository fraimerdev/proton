import { describe, expect, test } from 'bun:test';
import {
  BARE,
  EVERYONE_ROLE,
  GUILD,
  harness,
  LOW_ROLE,
  MEMBER,
  MID_ROLE,
  MODERATOR,
  QUARANTINE_ROLE,
  QUARANTINED,
  stringOption,
  userOption,
} from './harness.ts';

function sorted(ids: string[]): string[] {
  return [...ids].sort();
}

describe('/quarantine and /unquarantine', () => {
  test('records the prior roles and restores them exactly', async () => {
    const h = harness();
    const before = sorted(h.rolesOf(MEMBER));
    expect(before).toEqual(sorted([EVERYONE_ROLE, LOW_ROLE, MID_ROLE]));

    await h.run('quarantine', [userOption('user', MEMBER), stringOption('reason', 'ban evasion')], {
      config: QUARANTINED,
    });

    expect(sorted(h.rolesOf(MEMBER))).toEqual(sorted([EVERYONE_ROLE, QUARANTINE_ROLE]));

    const record = await h.quarantine.get(GUILD, MEMBER);

    expect(record?.priorRoleIds).toEqual([MID_ROLE, LOW_ROLE]);
    expect(record?.quarantinedBy).toBe(MODERATOR);
    expect(record?.reason).toBe('ban evasion');

    await h.run('unquarantine', [userOption('user', MEMBER)], { config: QUARANTINED });

    expect(sorted(h.rolesOf(MEMBER))).toEqual(before);

    expect(await h.quarantine.get(GUILD, MEMBER)).toBeNull();
  });

  test('writes the record before the first role comes off', async () => {
    const h = harness();
    const observed: Array<string[] | null> = [];

    const realRequest = h.rest.request.bind(h.rest);
    h.rest.request = async (options) => {
      if (options.method === 'DELETE' && observed.length === 0) {
        observed.push((await h.quarantine.get(GUILD, MEMBER))?.priorRoleIds ?? null);
      }
      return realRequest(options);
    };

    await h.run('quarantine', [userOption('user', MEMBER)], { config: QUARANTINED });

    expect(observed[0]).toEqual([MID_ROLE, LOW_ROLE]);
  });

  test('every removal carries the full prior-role set into the case ledger', async () => {
    const h = harness();

    await h.run('quarantine', [userOption('user', MEMBER)], { config: QUARANTINED });

    const removals = h.cases().filter((c) => c.kind === 'remove_role');
    expect(removals).toHaveLength(2);
    for (const removal of removals) {
      expect((removal.payload as { priorRoleIds: string[] }).priorRoleIds).toEqual([
        MID_ROLE,
        LOW_ROLE,
      ]);
    }
  });

  test('a member with no roles quarantines and restores cleanly', async () => {
    const h = harness();
    expect(sorted(h.rolesOf(BARE))).toEqual([EVERYONE_ROLE]);

    await h.run('quarantine', [userOption('user', BARE)], { config: QUARANTINED });

    expect(sorted(h.rolesOf(BARE))).toEqual(sorted([EVERYONE_ROLE, QUARANTINE_ROLE]));

    const record = await h.quarantine.get(GUILD, BARE);
    expect(record).not.toBeNull();
    expect(record?.priorRoleIds).toEqual([]);

    expect(h.discordCalls().map((c) => c.method)).toEqual(['PUT']);
    expect(h.replyContent()).toContain('no roles beyond @everyone');

    await h.run('unquarantine', [userOption('user', BARE)], { config: QUARANTINED });

    expect(sorted(h.rolesOf(BARE))).toEqual([EVERYONE_ROLE]);
    expect(await h.quarantine.get(GUILD, BARE)).toBeNull();
    expect(h.replyContent()).toContain('exactly as they were');
  });

  test('refuses to quarantine somebody already quarantined, so the record survives', async () => {
    const h = harness();

    await h.run('quarantine', [userOption('user', MEMBER)], { config: QUARANTINED });
    const first = await h.quarantine.get(GUILD, MEMBER);

    await h.run('quarantine', [userOption('user', MEMBER)], { config: QUARANTINED });

    expect(await h.quarantine.get(GUILD, MEMBER)).toEqual(first);
    expect(h.replyContent()).toContain('already quarantined');
    expect(h.replyContent()).toContain('/unquarantine');
  });

  test('refuses to release somebody with no record rather than guessing', async () => {
    const h = harness();

    await h.run('unquarantine', [userOption('user', MEMBER)], { config: QUARANTINED });

    expect(h.discordCalls()).toEqual([]);
    expect(sorted(h.rolesOf(MEMBER))).toEqual(sorted([EVERYONE_ROLE, LOW_ROLE, MID_ROLE]));
    expect(h.replyContent()).toContain('no quarantine record');
  });

  test('keeps the record when a recorded role can no longer be restored', async () => {
    const h = harness();

    await h.run('quarantine', [userOption('user', MEMBER)], { config: QUARANTINED });

    h.positions.delete(MID_ROLE);

    await h.run('unquarantine', [userOption('user', MEMBER)], { config: QUARANTINED });

    expect(sorted(h.rolesOf(MEMBER))).toEqual(sorted([EVERYONE_ROLE, LOW_ROLE]));

    expect(h.replyContent()).toContain(MID_ROLE);
    expect(h.replyContent()).toContain('no longer exist');
    expect(h.replyContent()).toContain('KEPT');
    expect(await h.quarantine.get(GUILD, MEMBER)).not.toBeNull();
  });

  test('refuses when the quarantine role sits above the bot, changing nothing', async () => {
    const h = harness();
    h.positions.set(QUARANTINE_ROLE, 9);

    await h.run('quarantine', [userOption('user', MEMBER)], { config: QUARANTINED });

    expect(h.discordCalls()).toEqual([]);
    expect(await h.quarantine.get(GUILD, MEMBER)).toBeNull();
    expect(sorted(h.rolesOf(MEMBER))).toEqual(sorted([EVERYONE_ROLE, LOW_ROLE, MID_ROLE]));
    expect(h.replyContent()).toContain('Server Settings → Roles');
  });

  test('says which role is missing when no quarantine role is configured', async () => {
    const h = harness();

    await h.run('quarantine', [userOption('user', MEMBER)], { config: { enabled: true } });

    expect(h.discordCalls()).toEqual([]);
    expect(h.replyContent()).toContain('No quarantine role is set');
  });

  test('answers even when the module is switched off', async () => {
    const h = harness();

    await h.run('quarantine', [userOption('user', MEMBER)], { config: { enabled: false } });

    expect(h.replyContent()).toContain('switched off');
  });
});
