import { describe, expect, test } from 'bun:test';
import {
  buildSnapshot,
  coverageOf,
  describeCapture,
  guildSnapshotSchema,
  SNAPSHOT_VERSION,
} from '../src/snapshot.ts';
import { fixtureLayout, HIDDEN_CHANNEL, layout, NOW, rawChannel, rawRole } from './harness.ts';

describe('capturing a guild', () => {
  test('records every visible channel and role', () => {
    const { snapshot, report } = buildSnapshot(fixtureLayout('guildCreate'), NOW);

    expect(snapshot.schemaVersion).toBe(SNAPSHOT_VERSION);
    expect(snapshot.capturedAt).toBe(NOW);
    expect(snapshot.channels).toHaveLength(1);
    expect(snapshot.channels[0]?.name).toBe('general');
    expect(snapshot.roles.map((role) => role.name)).toEqual(['@everyone', 'Member']);
    expect(report.channelsCaptured).toBe(1);
    expect(report.rolesCaptured).toBe(2);
    expect(report.obfuscatedChannelIds).toEqual([]);
  });

  test('is a document its own schema accepts after a jsonb round trip', () => {
    const { snapshot } = buildSnapshot(fixtureLayout('guildCreate'), NOW);

    // What Postgres gives back is parsed JSON, not the object that went in — so
    // this is the shape `DrizzleBackupStore.get` actually has to validate.
    const reread = guildSnapshotSchema.safeParse(JSON.parse(JSON.stringify(snapshot)));

    expect(reread.success).toBe(true);
    expect(reread.data).toEqual(snapshot);
  });

  test('keeps permission bitfields as decimal strings', () => {
    // PIN_MESSAGES is 1<<51 (§10.3) — far past 2^53 once combined. A snapshot
    // that stored these as numbers would silently round a server's permissions.
    const big = String((1n << 51n) | (1n << 44n));
    const { snapshot } = buildSnapshot(
      layout(
        [
          rawChannel({
            permission_overwrites: [{ id: '400000000000000010', type: 0, allow: big, deny: '0' }],
          }),
        ],
        [rawRole({ permissions: big })],
      ),
      NOW,
    );

    expect(snapshot.roles[0]?.permissions).toBe(big);
    expect(snapshot.channels[0]?.overwrites[0]?.allow).toBe(big);
  });
});

describe('a channel Proton cannot see (§10.1)', () => {
  test('is marked, and none of its hidden fields are captured', () => {
    const { snapshot } = buildSnapshot(fixtureLayout('channelObfuscated'), NOW);

    const hidden = snapshot.channels.find((channel) => channel.id === HIDDEN_CHANNEL);

    expect(hidden?.obfuscated).toBe(true);
    // Discord sends `___hidden___`. Storing that would put a lie in the backup:
    // a restore would recreate a channel literally called ___hidden___.
    expect(hidden?.name).toBeNull();
    expect(hidden?.topic).toBeNull();
    // The dispatch carries overwrites for it, and they are dropped on purpose:
    // Discord nulls the sensitive fields of a hidden channel, so what arrives
    // cannot be assumed complete, and restoring half a permission set silently
    // rewrites that channel's access rules.
    expect(hidden?.overwrites).toEqual([]);
  });

  test('keeps the four fields Discord never obfuscates', () => {
    const { snapshot } = buildSnapshot(fixtureLayout('channelObfuscated'), NOW);
    const hidden = snapshot.channels.find((channel) => channel.id === HIDDEN_CHANNEL);

    expect(hidden?.id).toBe(HIDDEN_CHANNEL);
    expect(hidden?.type).toBe(0);
    expect(hidden?.position).toBe(1);
    expect(hidden?.parentId).toBeNull();
  });

  test('is still in the snapshot, so the gap is visible rather than absent', () => {
    const { snapshot, report } = buildSnapshot(fixtureLayout('channelObfuscated'), NOW);

    expect(snapshot.channels).toHaveLength(2);
    expect(report.channelsCaptured).toBe(1);
    expect(report.obfuscatedChannelIds).toEqual([HIDDEN_CHANNEL]);
  });

  test('is detected by the flag, never by the name', () => {
    // A guild may legitimately name a real channel `___hidden___`. Matching the
    // string would hide a channel Proton can see perfectly well.
    const { snapshot, report } = buildSnapshot(
      layout([rawChannel({ name: '___hidden___', topic: '___hidden___', flags: 0 })]),
      NOW,
    );

    expect(snapshot.channels[0]?.obfuscated).toBe(false);
    expect(snapshot.channels[0]?.name).toBe('___hidden___');
    expect(report.obfuscatedChannelIds).toEqual([]);
  });

  test('is recognised whatever else is set in the flags bitfield', () => {
    // CHANNEL_OBFUSCATED is one bit among many; an equality test against
    // 131072 would stop working the moment Discord sets another flag too.
    const { snapshot } = buildSnapshot(layout([rawChannel({ flags: (1 << 17) | (1 << 4) })]), NOW);

    expect(snapshot.channels[0]?.obfuscated).toBe(true);
  });
});

describe('the report an admin gets at backup time', () => {
  test('names the permission, the channels, and what the gap means later', () => {
    const { report } = buildSnapshot(fixtureLayout('channelObfuscated'), NOW);
    const text = describeCapture(report).join('\n');

    expect(text).toContain('could NOT be backed up');
    expect(text).toContain(`<#${HIDDEN_CHANNEL}>`);
    expect(text).toContain('View Channel');
    // Where to fix it — "the bot did nothing" is a bug (§1).
    expect(text).toContain('Channel Settings → Permissions');
    // And what it will mean at restore, while there is still time to act.
    expect(text).toContain('untouched');
  });

  test('says nothing alarming when everything was captured', () => {
    const { report } = buildSnapshot(fixtureLayout('guildCreate'), NOW);
    const text = describeCapture(report).join('\n');

    expect(text).toContain('Backed up 1 channel and 2 roles.');
    expect(text).not.toContain('could NOT');
  });

  test('warns that a REST-sourced snapshot cannot count what is missing from it', () => {
    // §10.1: GET /guilds/{id}/channels omits obfuscated channels entirely, so
    // "0 hidden channels" from that source means "unknown", not "none".
    const { report } = buildSnapshot(layout([rawChannel()], [], 'rest'), NOW);

    expect(describeCapture(report).join('\n')).toContain('may therefore be missing channels');
  });

  test('counts objects it could not read instead of dropping them silently', () => {
    const { snapshot, report } = buildSnapshot(layout([rawChannel(), { no_id: true }], [{}]), NOW);

    expect(snapshot.channels).toHaveLength(1);
    expect(report.unreadable).toBe(2);
    expect(describeCapture(report).join('\n')).toContain('could not be read by this version');
  });

  test('loses only the odd object, not the whole backup', () => {
    // One channel with an id that is not a snowflake, and one role whose
    // permissions are not a bitfield. Throwing here would mean the guild ends up
    // with no backup at all because of one malformed entry.
    const { snapshot, report } = buildSnapshot(
      layout(
        [rawChannel(), rawChannel({ id: 'not-a-snowflake' })],
        [rawRole(), rawRole({ id: '400000000000000011', permissions: 'oops' })],
      ),
      NOW,
    );

    expect(snapshot.channels).toHaveLength(1);
    expect(snapshot.roles).toHaveLength(1);
    expect(report.unreadable).toBe(2);
  });
});

describe('coverage read back from a stored snapshot', () => {
  test('agrees with the report the capture produced', () => {
    const { snapshot, report } = buildSnapshot(fixtureLayout('channelObfuscated'), NOW);
    const coverage = coverageOf(snapshot);

    expect(coverage.channelsCaptured).toBe(report.channelsCaptured);
    expect(coverage.obfuscatedChannelIds).toEqual(report.obfuscatedChannelIds);
    expect(coverage.rolesCaptured).toBe(report.rolesCaptured);
  });
});
