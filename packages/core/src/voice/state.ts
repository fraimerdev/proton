export interface VoiceState {
  userId: string;

  channelId: string | null;
  selfDeaf: boolean;
  serverDeaf: boolean;

  isBot: boolean | null;

  roleIds: string[] | null;
  joinedAt: string | null;
  premiumSince: string | null;
}

export function readVoiceState(payload: unknown): VoiceState | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = payload as Record<string, unknown>;

  const userId = typeof raw.user_id === 'string' ? raw.user_id : null;
  if (userId === null) return null;

  const member =
    typeof raw.member === 'object' && raw.member !== null
      ? (raw.member as Record<string, unknown>)
      : null;
  const user = member === null ? null : member.user;
  const bot =
    typeof user === 'object' && user !== null ? (user as Record<string, unknown>).bot : undefined;
  const roles = member === null ? null : member.roles;

  return {
    userId,
    channelId: typeof raw.channel_id === 'string' ? raw.channel_id : null,
    selfDeaf: raw.self_deaf === true,
    serverDeaf: raw.deaf === true,
    isBot: typeof bot === 'boolean' ? bot : null,
    roleIds: Array.isArray(roles)
      ? roles.filter((role): role is string => typeof role === 'string')
      : null,
    joinedAt: typeof member?.joined_at === 'string' ? member.joined_at : null,
    premiumSince: typeof member?.premium_since === 'string' ? member.premium_since : null,
  };
}

export interface VoiceEligibilityOptions {
  excludedChannelIds: ReadonlySet<string>;
}

export function isVoiceEligible(
  state: Pick<VoiceState, 'channelId' | 'selfDeaf' | 'serverDeaf' | 'isBot'>,
  options: VoiceEligibilityOptions,
): boolean {
  if (state.channelId === null) return false;
  if (state.isBot === true) return false;
  if (state.selfDeaf || state.serverDeaf) return false;

  return !options.excludedChannelIds.has(state.channelId);
}
