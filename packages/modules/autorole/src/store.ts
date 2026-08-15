export interface StickyRoleStore {
  snapshot(guildId: string, userId: string, roleIds: readonly string[]): Promise<void>;

  read(guildId: string, userId: string): Promise<string[] | null>;
}
