/**
 * Where a member's roles are remembered between leaving and returning.
 *
 * A port rather than a database call, for the reason every Phase 2 module states:
 * §7's `ModuleContext` hands a module a guild id, its config, an executor and a
 * logger, and nothing else. The Drizzle implementation is built in `apps/worker`
 * next to the handle it needs and injected here.
 */
export interface StickyRoleStore {
  /**
   * Record the roles a member currently holds.
   *
   * Called from `member.updated`, which is the only dispatch that carries a
   * member's roles while they are still present. `GUILD_MEMBER_REMOVE` carries
   * the user and the guild and nothing else, so by the time someone leaves there
   * is nothing left to read — which is the whole reason this runs continuously
   * rather than at the moment of departure.
   */
  snapshot(guildId: string, userId: string, roleIds: readonly string[]): Promise<void>;

  /** The roles last recorded for this member, or null if none ever were. */
  read(guildId: string, userId: string): Promise<string[] | null>;
}
