import { describe, expect, test } from 'bun:test';
import {
  describeRestore,
  isRestoreRefusal,
  planRestore,
  type RestorePlan,
  restoreIsDryRun,
} from '../src/restore.ts';
import { buildSnapshot, type GuildLayout, type GuildSnapshot } from '../src/snapshot.ts';
import {
  EVERYONE_ROLE,
  fixtureLayout,
  GUILD,
  HIDDEN_CHANNEL,
  layout,
  NOW,
  rawChannel,
  rawRole,
  toRawChannel,
  toRawRole,
} from './harness.ts';

const CATEGORY = '500000000000000020';
const MOD_CHAT = '500000000000000021';
const STAFF_VC = '500000000000000022';
const GENERAL = '500000000000000023';
const MEMBER_ROLE = '400000000000000010';
const MOD_ROLE = '400000000000000011';
const BOT_ROLE = '400000000000000012';

const everyone = rawRole({ id: EVERYONE_ROLE, name: '@everyone', position: 0 });
/** A bot's own role: Discord creates it and refuses to let anyone else. */
const managed = rawRole({ id: BOT_ROLE, name: 'Proton', position: 3, managed: true });

/** A server with a category, children under it, overwrites, and a voice channel. */
function fullGuild(): GuildLayout {
  return layout(
    [
      rawChannel({ id: CATEGORY, type: 4, name: 'Staff', position: 0 }),
      rawChannel({
        id: MOD_CHAT,
        name: 'mod-chat',
        position: 1,
        parent_id: CATEGORY,
        topic: 'staff only',
        nsfw: false,
        rate_limit_per_user: 10,
        permission_overwrites: [{ id: MOD_ROLE, type: 0, allow: '1024', deny: '0' }],
      }),
      rawChannel({
        id: STAFF_VC,
        type: 2,
        name: 'Staff VC',
        position: 2,
        parent_id: CATEGORY,
        bitrate: 64_000,
        user_limit: 5,
      }),
      rawChannel({ id: GENERAL, name: 'general', position: 0 }),
    ],
    [
      everyone,
      rawRole({ id: MEMBER_ROLE, position: 1 }),
      rawRole({ id: MOD_ROLE, name: 'Moderator', position: 2 }),
      managed,
    ],
  );
}

/**
 * A server that has just been nuked: every channel gone, and only the two roles
 * Discord will not let anyone delete out from under it.
 */
function nukedGuild(): GuildLayout {
  return layout([], [everyone, managed]);
}

/**
 * Model of an applier: run the plan and hand back the guild it produced.
 *
 * Ids are preserved rather than reassigned — see `toRawChannel` in the harness
 * for why. Nothing in `src` can do this yet (blocker 1 on `createBackupModule`);
 * this exists to close the loop on whether the snapshot is complete.
 */
function apply(present: GuildLayout, plan: RestorePlan): GuildLayout {
  const channels = [...present.channels];
  const roles = [...present.roles];

  for (const op of plan.ops) {
    if (op.op === 'create_role') roles.push(toRawRole(op.role));
    else channels.push(toRawChannel(op.channel));
  }

  return { ...present, channels, roles };
}

function sortById<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

function plan(snapshot: GuildSnapshot, present: GuildLayout): RestorePlan {
  const result = planRestore({ backupId: 'backup-1', snapshot, present, dryRun: true });
  if (isRestoreRefusal(result)) throw new Error(`unexpected refusal: ${result.refusal}`);
  return result;
}

describe('a fully visible guild', () => {
  test('round-trips exactly through snapshot and restore', () => {
    const original = buildSnapshot(fullGuild(), NOW).snapshot;

    const restored = buildSnapshot(apply(nukedGuild(), plan(original, nukedGuild())), NOW).snapshot;

    // Every channel back, field for field — including the voice channel's
    // bitrate and the overwrite that makes mod-chat private. If the snapshot had
    // dropped a field a restore needs, these would differ.
    expect(sortById(restored.channels)).toEqual(sortById(original.channels));
    // Roles too: @everyone and the managed role were already there and are not
    // recreated, and the two real roles are.
    expect(sortById(restored.roles)).toEqual(sortById(original.roles));
  });

  test('creates roles before channels, and categories before their children', () => {
    const kinds = plan(buildSnapshot(fullGuild(), NOW).snapshot, nukedGuild()).ops.map(
      (op) => op.op,
    );
    expect(kinds.slice(0, 2)).toEqual(['create_role', 'create_role']);

    const ops = plan(buildSnapshot(fullGuild(), NOW).snapshot, nukedGuild()).ops;
    const at = (id: string) =>
      ops.findIndex((op) => op.op === 'create_channel' && op.channel.id === id);

    // Discord rejects a channel whose parent_id does not exist yet.
    expect(at(CATEGORY)).toBeLessThan(at(MOD_CHAT));
    expect(at(CATEGORY)).toBeLessThan(at(STAFF_VC));
  });

  test('is deterministic — the same backup plans the same way twice', () => {
    const snapshot = buildSnapshot(fullGuild(), NOW).snapshot;

    expect(plan(snapshot, nukedGuild()).ops).toEqual(plan(snapshot, nukedGuild()).ops);
  });
});

describe('restoring into a guild that is still intact', () => {
  test('does nothing at all', () => {
    const snapshot = buildSnapshot(fullGuild(), NOW).snapshot;
    const planned = plan(snapshot, fullGuild());

    expect(planned.ops).toEqual([]);
    // Everything is skipped because it is still there — bar @everyone, which is
    // recognised for what it is before the "does it exist" question is asked.
    expect(planned.skipped.filter((skip) => skip.id !== EVERYONE_ROLE)).toHaveLength(
      planned.skipped.length - 1,
    );
    expect(
      planned.skipped
        .filter((skip) => skip.id !== EVERYONE_ROLE)
        .every((skip) => skip.code === 'already_present'),
    ).toBe(true);
  });

  test('leaves channels created after the backup alone', () => {
    // A restore is additive. The attacker removed things; removing more turns a
    // partial loss into a total one (§15).
    const snapshot = buildSnapshot(fullGuild(), NOW).snapshot;
    const later = fullGuild();
    const present = {
      ...later,
      channels: [...later.channels, rawChannel({ id: '500000000000000099', name: 'new' })],
    };

    const planned = plan(snapshot, present);

    expect(planned.ops).toEqual([]);
    expect(JSON.stringify(planned)).not.toContain('500000000000000099');
  });
});

describe('a channel Proton could not see (Gate 2)', () => {
  test('is skipped rather than recreated wrong', () => {
    const snapshot = buildSnapshot(fixtureLayout('channelObfuscated'), NOW).snapshot;
    const planned = plan(snapshot, layout([], [everyone]));

    const skip = planned.skipped.find((entry) => entry.id === HIDDEN_CHANNEL);

    expect(skip?.code).toBe('obfuscated_at_backup');
    expect(skip?.reason).toContain('View Channel');
    // And nothing in the plan touches it — no nameless channel appears where a
    // private one used to be.
    expect(
      planned.ops.some((op) => op.op === 'create_channel' && op.channel.id === HIDDEN_CHANNEL),
    ).toBe(false);
  });

  test('is reported to the admin with what to do about it', () => {
    const snapshot = buildSnapshot(fixtureLayout('channelObfuscated'), NOW).snapshot;
    const text = describeRestore(plan(snapshot, layout([], [everyone]))).join('\n');

    expect(text).toContain('cannot be restored');
    expect(text).toContain(`<#${HIDDEN_CHANNEL}>`);
    expect(text).toContain('View Channel');
    expect(text).toContain('take a new backup');
  });

  test('names the children it orphans when the hidden channel was a category', () => {
    const hiddenCategory = layout([
      rawChannel({ id: CATEGORY, type: 4, name: '___hidden___', flags: 1 << 17 }),
      rawChannel({ id: MOD_CHAT, name: 'mod-chat', parent_id: CATEGORY }),
    ]);

    const planned = plan(buildSnapshot(hiddenCategory, NOW).snapshot, layout([]));

    expect(planned.ops).toHaveLength(1);
    expect(planned.warnings.join('\n')).toContain('original category');
    expect(planned.warnings.join('\n')).toContain('mod-chat');
  });
});

describe('roles Discord will not let Proton create', () => {
  test('are skipped, with the reason', () => {
    const snapshot = buildSnapshot(fullGuild(), NOW).snapshot;
    const planned = plan(snapshot, layout([]));

    const byId = new Map(planned.skipped.map((skip) => [skip.id, skip]));

    expect(byId.get(EVERYONE_ROLE)?.code).toBe('everyone_role');
    expect(byId.get(BOT_ROLE)?.code).toBe('managed_role');
    expect(planned.ops.some((op) => op.op === 'create_role' && op.role.id === BOT_ROLE)).toBe(
      false,
    );
  });
});

describe('refusals', () => {
  test('a REST-sourced view of the guild, which cannot see hidden channels', () => {
    // §10.1: the REST list omits them, so every hidden channel would look
    // missing and be recreated beside the one that already exists.
    const snapshot = buildSnapshot(fullGuild(), NOW).snapshot;
    const result = planRestore({
      backupId: 'backup-1',
      snapshot,
      present: layout([], [], 'rest'),
      dryRun: true,
    });

    expect(isRestoreRefusal(result)).toBe(true);
    expect(isRestoreRefusal(result) && result.refusal).toContain('REST channel list');
  });

  test('a snapshot from another server', () => {
    const snapshot = buildSnapshot(fullGuild(), NOW).snapshot;
    const elsewhere = { ...layout([]), guildId: '900000000000000002' };

    const result = planRestore({ backupId: 'b', snapshot, present: elsewhere, dryRun: true });

    expect(isRestoreRefusal(result) && result.refusal).toContain('not this one');
  });

  test('a snapshot written by a newer Proton', () => {
    const snapshot = { ...buildSnapshot(fullGuild(), NOW).snapshot, schemaVersion: 99 };

    const result = planRestore({ backupId: 'b', snapshot, present: layout([]), dryRun: true });

    expect(isRestoreRefusal(result) && result.refusal).toContain('format version 99');
  });
});

describe('I12', () => {
  test('a restore is a dry run everywhere but production', () => {
    expect(restoreIsDryRun('development')).toBe(true);
    expect(restoreIsDryRun('test')).toBe(true);
    expect(restoreIsDryRun(undefined)).toBe(true);
    expect(restoreIsDryRun('production')).toBe(false);
  });

  test('says so in the report, rather than leaving the admin to assume', () => {
    const snapshot = buildSnapshot(fullGuild(), NOW).snapshot;
    const preview = { ...plan(snapshot, nukedGuild()), dryRun: true };

    expect(describeRestore(preview).join('\n')).toContain('Nothing was changed');
  });
});

describe('the guild id', () => {
  test('is the @everyone role id Discord uses', () => {
    // Relied on by `planRestore` to recognise @everyone without being told.
    expect(EVERYONE_ROLE).toBe(GUILD);
  });
});
