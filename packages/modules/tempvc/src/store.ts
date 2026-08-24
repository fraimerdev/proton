/**
 * Where Proton last saw each member, and who is in each channel.
 *
 * This is a cache of something Discord already knows, which is why it can live in Redis with a TTL
 * — unlike ownership, which is authoritative and now lives in Postgres. VOICE_STATE_UPDATE carries
 * only the channel a member is in *now*, so the one they left has to be remembered here or their
 * old channel can never be found and emptied.
 */
export interface PresenceStore {
  locate(guildId: string, userId: string): Promise<string | null>;
  place(guildId: string, userId: string, channelId: string | null): Promise<void>;

  enter(guildId: string, channelId: string, userId: string): Promise<number>;
  leave(guildId: string, channelId: string, userId: string): Promise<number>;

  occupants(guildId: string, channelId: string): Promise<string[]>;

  /** Rewrites a channel's occupants wholesale, which is how a reconnect re-learns the truth. */
  reset(guildId: string, channelId: string, userIds: readonly string[]): Promise<void>;
}
