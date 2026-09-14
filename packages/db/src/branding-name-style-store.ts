import {
  type BotNameStyle,
  type BrandingNameStyleStore,
  type NameStyleAttempt,
  type NameStyleState,
  nameStyleAttemptSchema,
  nameStyleStateSchema,
} from '@proton/core';
import { eq, sql } from 'drizzle-orm';
import type { DbHandle } from './client.ts';
import { type BrandingNameStyleRow, brandingNameStyles } from './schema/branding-name-styles.ts';

export function toNameStyleState(row: BrandingNameStyleRow): NameStyleState | null {
  const confirmedAt = row.confirmedAt?.getTime() ?? null;

  const parsed = nameStyleStateSchema.safeParse({
    guildId: row.guildId,
    requested: row.requested ?? null,
    outcome: row.outcome,
    reason: row.reason ?? null,
    attemptedAt: row.attemptedAt?.getTime() ?? null,
    confirmed: confirmedAt === null ? null : (row.confirmed ?? null),
    confirmedAt,
    updatedAt: row.updatedAt.getTime(),
  });

  return parsed.success ? parsed.data : null;
}

export class DrizzleBrandingNameStyleStore implements BrandingNameStyleStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  async get(guildId: string): Promise<NameStyleState | null> {
    const rows = await this.#handle.db
      .select()
      .from(brandingNameStyles)
      .where(eq(brandingNameStyles.guildId, guildId))
      .limit(1);

    const row = rows[0];
    return row ? toNameStyleState(row) : null;
  }

  async recordAttempt(attempt: NameStyleAttempt): Promise<void> {
    const values = nameStyleAttemptSchema.parse(attempt);
    const at = new Date(values.at);

    const attempted = {
      requested: values.requested,
      outcome: values.outcome,
      reason: values.reason,
      attemptedAt: at,
      updatedAt: at,
    };
    const confirmed =
      values.outcome === 'confirmed' ? { confirmed: values.requested, confirmedAt: at } : {};

    await this.#handle.db
      .insert(brandingNameStyles)
      .values({ guildId: values.guildId, ...attempted, ...confirmed })
      .onConflictDoUpdate({
        target: brandingNameStyles.guildId,
        set: { ...attempted, ...confirmed },
      });
  }

  async confirmObserved(guildId: string, style: BotNameStyle | null, at: number): Promise<void> {
    const values = nameStyleAttemptSchema.parse({
      guildId,
      requested: style,
      outcome: 'confirmed',
      reason: null,
      at,
    });
    const when = new Date(values.at);

    const observed = {
      requested: values.requested,
      outcome: values.outcome,
      reason: values.reason,
      confirmed: values.requested,
      confirmedAt: when,
      updatedAt: when,
    };

    await this.#handle.db
      .insert(brandingNameStyles)
      .values({ guildId: values.guildId, ...observed })
      .onConflictDoUpdate({ target: brandingNameStyles.guildId, set: observed });
  }

  async forgetConfirmed(guildId: string, at: number): Promise<void> {
    const { outcome, reason } = brandingNameStyles;

    await this.#handle.db
      .update(brandingNameStyles)
      .set({
        confirmed: null,
        confirmedAt: null,
        updatedAt: new Date(at),
        // Both CASEs read the row as it was before this UPDATE, so reason still sees the old outcome.
        outcome: sql`case when ${outcome} = 'confirmed' then 'unverified' else ${outcome} end`,
        reason: sql`case when ${outcome} = 'confirmed' then 'changed_in_discord' else ${reason} end`,
      })
      .where(eq(brandingNameStyles.guildId, guildId));
  }
}
