import { describe, expect, test } from 'bun:test';
import { type PermissionOverwriteSpec, Permissions } from '@proton/core';
import fc from 'fast-check';
import {
  memberOverwrite,
  mergeOverwrites,
  OVERWRITE_MEMBER,
  OVERWRITE_ROLE,
  TICKET_LOCKED_ALLOW,
  TICKET_MEMBER_ALLOW,
  ticketOverwrites,
  withoutParticipant,
  withParticipant,
} from '../src/overwrites.ts';

const RUNS = { numRuns: 300 };

const GUILD_ID = '900000000000000001';

const snowflake = fc
  .integer({ min: 1, max: 9_999_999 })
  .map((n) => `1${String(n).padStart(17, '0')}`);

// The guild id is drawn from the same pool on purpose: @everyone is a role whose id equals the
// guild's, and every property here has to hold when a caller passes it as a support role.
const idPool = fc.oneof(snowflake, fc.constant(GUILD_ID));

const input = fc.record({
  guildId: fc.constant(GUILD_ID),
  ownerId: idPool,
  staffRoleIds: fc.array(idPool, { maxLength: 6 }),
  botUserId: fc.oneof(idPool, fc.constant(undefined)),
  participantIds: fc.array(idPool, { maxLength: 6 }),
  locked: fc.boolean(),
});

function keyOf(entry: PermissionOverwriteSpec): string {
  return `${entry.type}:${entry.id}`;
}

function grantedBits(overwrites: readonly PermissionOverwriteSpec[]): bigint {
  let granted = 0n;
  for (const entry of overwrites) granted |= BigInt(entry.allow ?? '0');
  return granted;
}

describe('what ticketOverwrites guarantees for any configuration', () => {
  test('@everyone is denied ViewChannel exactly once, which is what makes a ticket private', () => {
    fc.assert(
      fc.property(input, (spec) => {
        const overwrites = ticketOverwrites(spec);
        const everyone = overwrites.filter(
          (entry) => entry.id === GUILD_ID && entry.type === OVERWRITE_ROLE,
        );

        expect(everyone).toHaveLength(1);
        expect(BigInt(everyone[0]?.deny ?? '0') & Permissions.ViewChannel).toBe(
          Permissions.ViewChannel,
        );
      }),
      RUNS,
    );
  });

  test('the @everyone role is never granted anything, however it reaches the staff list', () => {
    fc.assert(
      fc.property(input, (spec) => {
        for (const entry of ticketOverwrites(spec)) {
          if (entry.id === GUILD_ID && entry.type === OVERWRITE_ROLE) {
            expect(BigInt(entry.allow ?? '0')).toBe(0n);
          }
        }
      }),
      RUNS,
    );
  });

  test('no id appears twice with the same type, so Discord never sees a contradictory pair', () => {
    fc.assert(
      fc.property(input, (spec) => {
        const keys = ticketOverwrites(spec).map(keyOf);

        expect(new Set(keys).size).toBe(keys.length);
      }),
      RUNS,
    );
  });

  test('no overwrite both allows and denies the same bit for the same id', () => {
    fc.assert(
      fc.property(input, (spec) => {
        for (const entry of ticketOverwrites(spec)) {
          expect(BigInt(entry.allow ?? '0') & BigInt(entry.deny ?? '0')).toBe(0n);
        }
      }),
      RUNS,
    );
  });

  test('nothing beyond TICKET_MEMBER_ALLOW is ever granted, because the bot must hold what it grants', () => {
    fc.assert(
      fc.property(input, (spec) => {
        expect(grantedBits(ticketOverwrites(spec)) & ~TICKET_MEMBER_ALLOW).toBe(0n);
      }),
      RUNS,
    );
  });

  test('the owner is always present, even when they are also the bot or a participant', () => {
    fc.assert(
      fc.property(input, (spec) => {
        const forOwner = ticketOverwrites(spec).filter(
          (entry) => entry.id === spec.ownerId && entry.type === OVERWRITE_MEMBER,
        );

        expect(forOwner).toHaveLength(1);
      }),
      RUNS,
    );
  });

  test('every participant can reach the channel, which is the point of adding them', () => {
    fc.assert(
      fc.property(input, (spec) => {
        const overwrites = ticketOverwrites(spec);

        for (const participant of spec.participantIds) {
          const entry = overwrites.find(
            (candidate) => candidate.id === participant && candidate.type === OVERWRITE_MEMBER,
          );

          expect(entry).toBeDefined();
          expect(BigInt(entry?.allow ?? '0') & Permissions.ViewChannel).toBe(
            Permissions.ViewChannel,
          );
        }
      }),
      RUNS,
    );
  });

  test('a locked ticket still lets every member read it, or locking would be closing', () => {
    fc.assert(
      fc.property(input, (spec) => {
        for (const entry of ticketOverwrites({ ...spec, locked: true })) {
          if (entry.type !== OVERWRITE_MEMBER) continue;

          expect(BigInt(entry.allow ?? '0') & Permissions.ViewChannel).toBe(
            Permissions.ViewChannel,
          );
        }
      }),
      RUNS,
    );
  });

  test('locking silences the people in the ticket but never Proton, which still has to answer', () => {
    fc.assert(
      fc.property(input, (spec) => {
        const silenced = new Set([spec.ownerId, ...spec.participantIds]);
        silenced.delete(spec.botUserId ?? '');

        for (const entry of ticketOverwrites({ ...spec, locked: true })) {
          if (entry.type !== OVERWRITE_MEMBER || !silenced.has(entry.id)) continue;

          expect(BigInt(entry.allow ?? '0') & ~TICKET_LOCKED_ALLOW).toBe(0n);
          expect(BigInt(entry.deny ?? '0') & Permissions.SendMessages).toBe(
            Permissions.SendMessages,
          );
        }

        if (spec.botUserId !== undefined && !silenced.has(spec.botUserId)) {
          const bot = ticketOverwrites({ ...spec, locked: true }).find(
            (entry) => entry.id === spec.botUserId && entry.type === OVERWRITE_MEMBER,
          );

          expect(BigInt(bot?.deny ?? '0') & Permissions.SendMessages).toBe(0n);
        }
      }),
      RUNS,
    );
  });
});

describe('what participant edits guarantee', () => {
  test('adding the same member twice is the same as adding them once', () => {
    fc.assert(
      fc.property(input, snowflake, (spec, userId) => {
        const once = withParticipant(ticketOverwrites(spec), userId);

        expect(withParticipant(once, userId)).toEqual(once);
      }),
      RUNS,
    );
  });

  test('removing somebody who was added leaves the member overwrites as they were', () => {
    fc.assert(
      fc.property(input, snowflake, (spec, userId) => {
        const base = ticketOverwrites(spec).filter(
          (entry) => !(entry.id === userId && entry.type === OVERWRITE_MEMBER),
        );

        expect(withoutParticipant(withParticipant(base, userId), userId)).toEqual(base);
      }),
      RUNS,
    );
  });

  test('removing a member never removes a role overwrite, so the support team keeps its access', () => {
    fc.assert(
      fc.property(input, idPool, (spec, userId) => {
        const before = ticketOverwrites(spec);
        const roles = before.filter((entry) => entry.type === OVERWRITE_ROLE);
        const after = withoutParticipant(before, userId);

        for (const role of roles) expect(after).toContainEqual(role);
      }),
      RUNS,
    );
  });

  test('a single member overwrite grants no more than the full build would', () => {
    fc.assert(
      fc.property(snowflake, fc.boolean(), (userId, locked) => {
        expect(BigInt(memberOverwrite(userId, locked).allow ?? '0') & ~TICKET_MEMBER_ALLOW).toBe(
          0n,
        );
      }),
      RUNS,
    );
  });
});

describe('what merging guarantees', () => {
  const live = fc.array(
    fc.record({
      id: idPool,
      type: fc.constantFrom(OVERWRITE_ROLE, OVERWRITE_MEMBER) as fc.Arbitrary<0 | 1>,
      allow: fc.constantFrom('0', TICKET_MEMBER_ALLOW.toString()),
      deny: fc.constantFrom('0', Permissions.ViewChannel.toString()),
    }),
    { maxLength: 8 },
  );

  test('every required entry survives, so a stale cache cannot make a ticket public', () => {
    fc.assert(
      fc.property(input, live, (spec, existing) => {
        const required = ticketOverwrites(spec);
        const merged = mergeOverwrites(existing, required);

        for (const entry of required) expect(merged).toContainEqual(entry);
      }),
      RUNS,
    );
  });

  test('a live entry the required list says nothing about is kept, so nobody is silently revoked', () => {
    fc.assert(
      fc.property(input, live, (spec, existing) => {
        const required = ticketOverwrites(spec);
        const requiredKeys = new Set(required.map(keyOf));
        const merged = mergeOverwrites(existing, required);
        const mergedKeys = new Set(merged.map(keyOf));

        for (const entry of existing) {
          if (!requiredKeys.has(keyOf(entry))) expect(mergedKeys.has(keyOf(entry))).toBe(true);
        }
      }),
      RUNS,
    );
  });

  test('merging never invents a key that was in neither list', () => {
    fc.assert(
      fc.property(input, live, (spec, existing) => {
        const required = ticketOverwrites(spec);
        const known = new Set([...existing, ...required].map(keyOf));

        for (const entry of mergeOverwrites(existing, required)) {
          expect(known.has(keyOf(entry))).toBe(true);
        }
      }),
      RUNS,
    );
  });
});
