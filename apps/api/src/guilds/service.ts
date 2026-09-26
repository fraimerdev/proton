import type { DbHandle } from '@proton/db';
import { guilds } from '@proton/db/schema';
import { eq, isNotNull, sql } from 'drizzle-orm';
import type { BotGuildSource } from './directory.ts';

export interface GuildOverview {
  id: string;
  name: string;
  locale: string;
  tier: string;
  joinedAt: string;
}

export interface EnsureGuildInput {
  guildId: string;
  name: string;
  locale?: string | undefined;
  shardId?: number | undefined;
}

export interface GuildPresence {
  present: string[];
  known: boolean;
}

export type GuildDeparture = 'left' | 'present' | 'unknown';

export class GuildService {
  readonly #db: DbHandle;
  readonly #directory: BotGuildSource;

  constructor(db: DbHandle, directory: BotGuildSource) {
    this.#db = db;
    this.#directory = directory;
  }

  async ensureGuild(input: EnsureGuildInput): Promise<void> {
    await this.#db.db
      .insert(guilds)
      .values({
        id: input.guildId,
        name: input.name,
        ...(input.locale !== undefined ? { locale: input.locale } : {}),
        ...(input.shardId !== undefined ? { shardId: input.shardId } : {}),
      })
      .onConflictDoUpdate({
        target: guilds.id,
        set: {
          name: input.name,
          ...(input.locale !== undefined ? { locale: input.locale } : {}),
          ...(input.shardId !== undefined ? { shardId: input.shardId } : {}),
          leftAt: sql`null`,
        },
      });
  }

  async overview(guildId: string): Promise<GuildOverview | null> {
    const rows = await this.#db.db
      .select({
        id: guilds.id,
        name: guilds.name,
        locale: guilds.locale,
        tier: guilds.tier,
        joinedAt: guilds.joinedAt,
      })
      .from(guilds)
      .where(eq(guilds.id, guildId))
      .limit(1);

    const row = rows[0];
    return row ? { ...row, joinedAt: row.joinedAt.toISOString() } : null;
  }

  // Discord, not this table: a row only records that Proton was registered here once, and nothing
  // corrects it when a GUILD_DELETE is missed or when another deployment shares the database. An id
  // wrongly kept here is one the dashboard offers a settings page for, whose saves then go nowhere.
  async presence(guildIds: readonly string[]): Promise<GuildPresence> {
    if (guildIds.length === 0) return { present: [], known: true };

    const joined = await this.#directory.guilds();
    if (!joined) return { present: [], known: false };

    const present = guildIds.filter((id) => joined.has(id));
    await this.#reconcile(present, joined);

    return { present, known: true };
  }

  // Discord has just said Proton is in these, so a row saying otherwise is stale and a missing row
  // is a guild nothing can be saved for — guild_modules keys to it.
  async #reconcile(present: readonly string[], joined: ReadonlyMap<string, string>): Promise<void> {
    if (present.length === 0) return;

    await this.#db.db
      .insert(guilds)
      .values(present.map((id) => ({ id, name: joined.get(id) ?? id })))
      .onConflictDoUpdate({
        target: guilds.id,
        set: { leftAt: sql`null` },
        setWhere: isNotNull(guilds.leftAt),
      });
  }

  async recordedPresent(guildId: string): Promise<boolean> {
    const rows = await this.#db.db
      .select({ leftAt: guilds.leftAt })
      .from(guilds)
      .where(eq(guilds.id, guildId))
      .limit(1);

    const row = rows[0];
    return row !== undefined && row.leftAt === null;
  }

  // Not the event's word for it: a stale GUILD_DELETE can be handled after a rejoin's GUILD_CREATE.
  async markLeft(guildId: string): Promise<GuildDeparture> {
    const joined = await this.#directory.fresh();
    if (!joined) return 'unknown';
    if (joined.has(guildId)) return 'present';

    await this.#db.db
      .update(guilds)
      .set({ leftAt: sql`coalesce(${guilds.leftAt}, now())` })
      .where(eq(guilds.id, guildId));

    return 'left';
  }
}
