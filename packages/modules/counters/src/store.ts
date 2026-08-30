import type { DbHandle } from '@proton/db';
import { and, eq, inArray, not } from 'drizzle-orm';
import { counterChannels } from './table.ts';

export interface OwnedChannel {
  counterId: string;
  channelId: string;
}

export interface CounterChannelStore {
  list(guildId: string): Promise<OwnedChannel[]>;

  attach(guildId: string, counterId: string, channelId: string): Promise<void>;

  forgetAllBut(guildId: string, counterIds: readonly string[]): Promise<OwnedChannel[]>;
}

export class DrizzleCounterChannelStore implements CounterChannelStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  get #db() {
    return this.#handle.db;
  }

  async list(guildId: string): Promise<OwnedChannel[]> {
    const rows = await this.#db
      .select({ counterId: counterChannels.counterId, channelId: counterChannels.channelId })
      .from(counterChannels)
      .where(eq(counterChannels.guildId, guildId));

    return rows;
  }

  async attach(guildId: string, counterId: string, channelId: string): Promise<void> {
    await this.#db
      .insert(counterChannels)
      .values({ guildId, counterId, channelId })
      .onConflictDoUpdate({
        target: [counterChannels.guildId, counterChannels.counterId],
        set: { channelId },
      });
  }

  async forgetAllBut(guildId: string, counterIds: readonly string[]): Promise<OwnedChannel[]> {
    const scope =
      counterIds.length === 0
        ? eq(counterChannels.guildId, guildId)
        : and(
            eq(counterChannels.guildId, guildId),
            not(inArray(counterChannels.counterId, [...counterIds])),
          );

    const rows = await this.#db
      .delete(counterChannels)
      .where(scope)
      .returning({ counterId: counterChannels.counterId, channelId: counterChannels.channelId });

    return rows;
  }
}
