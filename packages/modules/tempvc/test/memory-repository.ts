import type { Reservation, ReserveInput, TempVoiceRepository } from '../src/repository.ts';
import type { AccessKind, TempVoiceChannelRow } from '../src/table.ts';

/**
 * The repository's contract without Postgres, so the whole lifecycle is testable on a machine with
 * no Docker. Every method mirrors the SQL's semantics — in particular `reserve` counts and inserts
 * as one step, and `claim` and `beginClose` only succeed for the first caller.
 */
export class MemoryTempVoiceRepository implements TempVoiceRepository {
  readonly rows = new Map<string, TempVoiceChannelRow>();
  readonly #access = new Map<string, Map<string, AccessKind>>();
  readonly #roles = new Map<string, Array<{ userId: string; roleId: string }>>();

  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  async reserve(input: ReserveInput): Promise<Reservation> {
    const held = [...this.rows.values()].filter(
      (row) =>
        row.guildId === input.guildId && row.ownerId === input.ownerId && row.status !== 'closing',
    );

    if (held.length >= input.maxChannelsPerUser) {
      return { refused: 'at_limit', live: held.length };
    }

    const row: TempVoiceChannelRow = {
      id: input.id,
      guildId: input.guildId,
      hubChannelId: input.hubChannelId,
      channelId: null,
      ownerId: input.ownerId,
      status: 'reserving',
      createdAt: this.#now(),
      lastActiveAt: this.#now(),
      deleteAfter: null,
    };

    this.rows.set(row.id, row);
    return { reserved: row };
  }

  async attach(id: string, channelId: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, channelId, status: 'live', lastActiveAt: this.#now() });
  }

  async abandon(id: string): Promise<void> {
    this.rows.delete(id);
  }

  async byChannel(guildId: string, channelId: string): Promise<TempVoiceChannelRow | null> {
    return (
      [...this.rows.values()].find(
        (row) => row.guildId === guildId && row.channelId === channelId,
      ) ?? null
    );
  }

  async byId(id: string): Promise<TempVoiceChannelRow | null> {
    return this.rows.get(id) ?? null;
  }

  async ownedBy(guildId: string, ownerId: string): Promise<TempVoiceChannelRow[]> {
    return [...this.rows.values()].filter(
      (row) => row.guildId === guildId && row.ownerId === ownerId && row.status === 'live',
    );
  }

  async liveIn(guildId: string): Promise<TempVoiceChannelRow[]> {
    return [...this.rows.values()].filter(
      (row) => row.guildId === guildId && row.status !== 'closing',
    );
  }

  async setOwner(id: string, ownerId: string | null): Promise<void> {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, ownerId, lastActiveAt: this.#now() });
  }

  async claim(id: string, ownerId: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (row?.status !== 'live' || row.ownerId !== null) return false;

    this.rows.set(id, { ...row, ownerId, lastActiveAt: this.#now() });
    return true;
  }

  async touch(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, lastActiveAt: this.#now() });
  }

  async scheduleDelete(id: string, at: Date): Promise<void> {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, deleteAfter: at });
  }

  async cancelDelete(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, deleteAfter: null, lastActiveAt: this.#now() });
  }

  async due(now: Date, limit: number): Promise<TempVoiceChannelRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.deleteAfter !== null && row.deleteAfter <= now && row.status === 'live')
      .slice(0, limit);
  }

  async beginClose(id: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (row?.status !== 'live') return false;

    this.rows.set(id, { ...row, status: 'closing' });
    return true;
  }

  async forget(id: string): Promise<void> {
    this.rows.delete(id);
    this.#access.delete(id);
    this.#roles.delete(id);
  }

  async access(tempChannelId: string): Promise<Array<{ userId: string; kind: AccessKind }>> {
    return [...(this.#access.get(tempChannelId) ?? new Map()).entries()].map(([userId, kind]) => ({
      userId,
      kind: kind as AccessKind,
    }));
  }

  async setAccess(tempChannelId: string, userId: string, kind: AccessKind): Promise<void> {
    const held = this.#access.get(tempChannelId) ?? new Map<string, AccessKind>();
    held.set(userId, kind);
    this.#access.set(tempChannelId, held);
  }

  async clearAccess(tempChannelId: string, userId: string): Promise<void> {
    this.#access.get(tempChannelId)?.delete(userId);
  }

  async grantedRole(tempChannelId: string, userId: string, roleId: string): Promise<void> {
    const held = this.#roles.get(tempChannelId) ?? [];
    if (!held.some((entry) => entry.userId === userId && entry.roleId === roleId)) {
      held.push({ userId, roleId });
    }
    this.#roles.set(tempChannelId, held);
  }

  async takeRole(tempChannelId: string, userId: string): Promise<string[]> {
    const held = this.#roles.get(tempChannelId) ?? [];
    const mine = held.filter((entry) => entry.userId === userId).map((entry) => entry.roleId);

    this.#roles.set(
      tempChannelId,
      held.filter((entry) => entry.userId !== userId),
    );

    return mine;
  }

  async rolesGranted(tempChannelId: string): Promise<Array<{ userId: string; roleId: string }>> {
    return [...(this.#roles.get(tempChannelId) ?? [])];
  }
}
