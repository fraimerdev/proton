import { describe, expect, test } from 'bun:test';
import type { BotNameStyle, NameStyleOutcome, NameStyleReason } from '@proton/core';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  DrizzleBrandingNameStyleStore,
  toNameStyleState,
} from '../src/branding-name-style-store.ts';
import type { DbHandle } from '../src/client.ts';
import {
  type BrandingNameStyleRow,
  brandingNameStyles,
} from '../src/schema/branding-name-styles.ts';

const GUILD = '1450209710199279760';
const MODERN_GRADIENT: BotNameStyle = { fontId: 6, effectId: 2, colours: [0x5865f2, 0xeb459e] };
const TEMPO_SOLID: BotNameStyle = { fontId: 12, effectId: 1, colours: [0] };
const EARLIER = new Date(1_787_000_000_000);
const LATER = 1_787_000_600_000;

function row(overrides: Partial<BrandingNameStyleRow> = {}): BrandingNameStyleRow {
  return {
    guildId: GUILD,
    requested: MODERN_GRADIENT,
    outcome: 'confirmed',
    reason: null,
    confirmed: MODERN_GRADIENT,
    attemptedAt: EARLIER,
    confirmedAt: EARLIER,
    updatedAt: EARLIER,
    ...overrides,
  };
}

interface Write {
  values?: Record<string, unknown>;
  set: Record<string, unknown>;
  target?: unknown;
}

function fakeHandle(rows: BrandingNameStyleRow[] = []): { handle: DbHandle; writes: Write[] } {
  const writes: Write[] = [];

  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: async (config: { target: unknown; set: Record<string, unknown> }) => {
          writes.push({ values, set: config.set, target: config.target });
        },
      }),
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => {
          writes.push({ set });
        },
      }),
    }),
  };

  return { handle: { db } as unknown as DbHandle, writes };
}

function upsertOnto(
  existing: BrandingNameStyleRow,
  set: Record<string, unknown>,
): BrandingNameStyleRow {
  return { ...existing, ...set };
}

function onlyWrite(writes: Write[]): Write {
  expect(writes).toHaveLength(1);
  const write = writes[0];
  if (!write) throw new Error('expected one write');
  return write;
}

describe('toNameStyleState', () => {
  test('turns every timestamp into epoch milliseconds', () => {
    expect(toNameStyleState(row())).toEqual({
      guildId: GUILD,
      requested: MODERN_GRADIENT,
      outcome: 'confirmed',
      reason: null,
      attemptedAt: EARLIER.getTime(),
      confirmed: MODERN_GRADIENT,
      confirmedAt: EARLIER.getTime(),
      updatedAt: EARLIER.getTime(),
    });
  });

  test('keeps a confirmed reset apart from nothing confirmed', () => {
    const reset = toNameStyleState(row({ requested: null, confirmed: null }));
    const never = toNameStyleState(
      row({ outcome: 'unverified', reason: 'no_answer', confirmed: null, confirmedAt: null }),
    );

    expect(reset?.confirmed).toBeNull();
    expect(reset?.confirmedAt).toBe(EARLIER.getTime());
    expect(never?.confirmed).toBeNull();
    expect(never?.confirmedAt).toBeNull();
  });

  test('ignores a stray confirmed style when nothing is confirmed', () => {
    const state = toNameStyleState(row({ outcome: 'ignored', confirmedAt: null }));

    expect(state?.confirmed).toBeNull();
    expect(state?.confirmedAt).toBeNull();
  });

  test('keeps a style that was observed but never attempted', () => {
    expect(toNameStyleState(row({ attemptedAt: null }))?.attemptedAt).toBeNull();
  });

  test.each([
    ['an unknown outcome', { outcome: 'applied' as NameStyleOutcome }],
    ['an unknown reason', { reason: 'timeout' as NameStyleReason }],
    ['a guild id that is not a snowflake', { guildId: 'guild' }],
    ['a requested style with font id 0', { requested: { ...MODERN_GRADIENT, fontId: 0 } }],
    ['a confirmed style with no colours', { confirmed: { ...MODERN_GRADIENT, colours: [] } }],
    ['an invalid timestamp', { updatedAt: new Date(Number.NaN) }],
  ])('reads a row with %s as never attempted instead of throwing', (_, overrides) => {
    expect(toNameStyleState(row(overrides))).toBeNull();
  });
});

describe('DrizzleBrandingNameStyleStore', () => {
  test('reads the guild’s row, and reads nothing when there is none or it is malformed', async () => {
    expect(await new DrizzleBrandingNameStyleStore(fakeHandle([row()]).handle).get(GUILD)).toEqual(
      toNameStyleState(row()),
    );
    expect(await new DrizzleBrandingNameStyleStore(fakeHandle().handle).get(GUILD)).toBeNull();
    expect(
      await new DrizzleBrandingNameStyleStore(
        fakeHandle([row({ outcome: 'applied' as NameStyleOutcome })]).handle,
      ).get(GUILD),
    ).toBeNull();
  });

  test.each([
    ['ignored', 'discord_ignored'],
    ['rejected', 'missing_change_nickname'],
    ['unverified', 'no_answer'],
  ] as const)('a %s attempt keeps the last confirmed style', async (outcome, reason) => {
    const { handle, writes } = fakeHandle();

    await new DrizzleBrandingNameStyleStore(handle).recordAttempt({
      guildId: GUILD,
      requested: TEMPO_SOLID,
      outcome,
      reason,
      at: LATER,
    });

    const write = onlyWrite(writes);
    expect(write.target).toBe(brandingNameStyles.guildId);
    expect(Object.keys(write.set)).not.toContain('confirmed');
    expect(Object.keys(write.set)).not.toContain('confirmedAt');
    expect(Object.keys(write.values ?? {})).not.toContain('confirmed');
    expect(toNameStyleState(upsertOnto(row(), write.set))).toEqual({
      guildId: GUILD,
      requested: TEMPO_SOLID,
      outcome,
      reason,
      attemptedAt: LATER,
      confirmed: MODERN_GRADIENT,
      confirmedAt: EARLIER.getTime(),
      updatedAt: LATER,
    });
  });

  test('a first attempt that fails inserts a row with nothing confirmed', async () => {
    const { handle, writes } = fakeHandle();

    await new DrizzleBrandingNameStyleStore(handle).recordAttempt({
      guildId: GUILD,
      requested: MODERN_GRADIENT,
      outcome: 'unverified',
      reason: 'not_readable',
      at: LATER,
    });

    expect(onlyWrite(writes).values).toEqual({
      guildId: GUILD,
      requested: MODERN_GRADIENT,
      outcome: 'unverified',
      reason: 'not_readable',
      attemptedAt: new Date(LATER),
      updatedAt: new Date(LATER),
    });
  });

  test('a confirmed attempt moves the confirmed style to the request', async () => {
    const { handle, writes } = fakeHandle();

    await new DrizzleBrandingNameStyleStore(handle).recordAttempt({
      guildId: GUILD,
      requested: TEMPO_SOLID,
      outcome: 'confirmed',
      reason: null,
      at: LATER,
    });

    const after = toNameStyleState(upsertOnto(row(), onlyWrite(writes).set));
    expect(after?.confirmed).toEqual(TEMPO_SOLID);
    expect(after?.confirmedAt).toBe(LATER);
    expect(after?.attemptedAt).toBe(LATER);
  });

  test('a confirmed reset records "confirmed no style", not "nothing confirmed"', async () => {
    const { handle, writes } = fakeHandle();

    await new DrizzleBrandingNameStyleStore(handle).recordAttempt({
      guildId: GUILD,
      requested: null,
      outcome: 'confirmed',
      reason: null,
      at: LATER,
    });

    const after = toNameStyleState(upsertOnto(row(), onlyWrite(writes).set));
    expect(after?.requested).toBeNull();
    expect(after?.confirmed).toBeNull();
    expect(after?.confirmedAt).toBe(LATER);
  });

  test('refuses an attempt no request could have carried, and writes nothing', async () => {
    const { handle, writes } = fakeHandle();

    await expect(
      new DrizzleBrandingNameStyleStore(handle).recordAttempt({
        guildId: GUILD,
        requested: { ...MODERN_GRADIENT, colours: [16777216] },
        outcome: 'ignored',
        reason: 'discord_ignored',
        at: LATER,
      }),
    ).rejects.toThrow();
    expect(writes).toHaveLength(0);
  });

  test('confirming an observation never claims an attempt was made', async () => {
    const { handle, writes } = fakeHandle();
    const failed = row({
      requested: TEMPO_SOLID,
      outcome: 'ignored',
      reason: 'discord_ignored',
      confirmed: null,
      confirmedAt: null,
    });

    await new DrizzleBrandingNameStyleStore(handle).confirmObserved(GUILD, TEMPO_SOLID, LATER);

    const write = onlyWrite(writes);
    expect(Object.keys(write.set)).not.toContain('attemptedAt');
    expect(Object.keys(write.values ?? {})).not.toContain('attemptedAt');
    expect(toNameStyleState(upsertOnto(failed, write.set))).toEqual({
      guildId: GUILD,
      requested: TEMPO_SOLID,
      outcome: 'confirmed',
      reason: null,
      attemptedAt: EARLIER.getTime(),
      confirmed: TEMPO_SOLID,
      confirmedAt: LATER,
      updatedAt: LATER,
    });
  });

  test('forgetting clears the confirmed style and marks a confirmed outcome as changed in Discord', async () => {
    const { handle, writes } = fakeHandle();
    const dialect = new PgDialect();

    await new DrizzleBrandingNameStyleStore(handle).forgetConfirmed(GUILD, LATER);

    const { set } = onlyWrite(writes);
    expect(set.confirmed).toBeNull();
    expect(set.confirmedAt).toBeNull();
    expect(set.updatedAt).toEqual(new Date(LATER));
    expect(dialect.sqlToQuery(set.outcome as SQL).sql).toBe(
      `case when "branding_name_styles"."outcome" = 'confirmed' then 'unverified' else "branding_name_styles"."outcome" end`,
    );
    expect(dialect.sqlToQuery(set.reason as SQL).sql).toBe(
      `case when "branding_name_styles"."outcome" = 'confirmed' then 'changed_in_discord' else "branding_name_styles"."reason" end`,
    );
  });
});
