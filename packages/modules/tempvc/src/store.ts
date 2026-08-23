export interface TempChannel {
  guildId: string;
  channelId: string;
  ownerId: string;
  hubChannelId: string;
}

export interface TempVcStore {
  claim(channel: TempChannel): Promise<void>;

  get(guildId: string, channelId: string): Promise<TempChannel | null>;

  ownedBy(guildId: string, userId: string): Promise<string | null>;

  release(guildId: string, channelId: string): Promise<void>;

  all(guildId: string): Promise<string[]>;

  // Where Proton last saw this member. VOICE_STATE_UPDATE carries only the channel they are in
  // now, so the channel they left has to be remembered or it can never be emptied.
  locate(guildId: string, userId: string): Promise<string | null>;

  place(guildId: string, userId: string, channelId: string | null): Promise<void>;

  enter(guildId: string, channelId: string, userId: string): Promise<number>;
  leave(guildId: string, channelId: string, userId: string): Promise<number>;

  occupants(guildId: string, channelId: string): Promise<number>;

  reset(guildId: string, channelId: string, userIds: readonly string[]): Promise<void>;
}
